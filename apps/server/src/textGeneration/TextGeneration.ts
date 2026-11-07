// The cache key hashes the full prompt, so it needs the same digest the
// server computes elsewhere for content addressing.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { buildCommitMessagePrompt, buildPrContentPrompt } from "./TextGenerationPrompts.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface WorkLessonsGenerationInput {
  /** Scratch directory the model runs in; the prompt carries all the context. */
  cwd: string;
  /** JSON of the structured work digests; never raw transcript text. */
  digest: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface WorkLessonsGenerationResult {
  lessons: ReadonlyArray<{
    category: "fact" | "prohibition" | "preference" | "procedure";
    text: string;
    /** Digest thread labels (T1, T2, …) the lesson draws on. */
    threads: ReadonlyArray<string>;
  }>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /** Propose reusable lessons from structured digests of recent work. */
    readonly generateWorkLessons: (
      input: WorkLessonsGenerationInput,
    ) => Effect.Effect<WorkLessonsGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateWorkLessons";

// ---------------------------------------------------------------------------
// Generation cache
// ---------------------------------------------------------------------------

// Commit messages and change request bodies are the expensive operations: their
// prompts carry up to 50k characters of patch, and re-running the same action on
// an unchanged diff rebuilds a byte-identical prompt. Caching the successful
// result makes the second identical request free.
//
// Only these two operations are cached. Thread titles and branch names are
// cheap and are regenerated to pick up new context, so they stay uncached.
const GENERATION_CACHE_CAPACITY = 32;
const GENERATION_CACHE_TTL = Duration.minutes(10);

/**
 * One generation request, usable as a cache key.
 *
 * The stored digest is the equality/hash identity, so a second request with the
 * same digest is a hit and never runs the model. The request carries its own
 * effect so the cache lookup can run it, and concurrent requests for one digest
 * share a single model call.
 */
class CachedGenerationRequest<A> {
  readonly digest: string;
  readonly generate: Effect.Effect<A, TextGenerationError>;

  constructor(digest: string, generate: Effect.Effect<A, TextGenerationError>) {
    this.digest = digest;
    this.generate = generate;
  }

  [Equal.symbol](that: unknown): boolean {
    return that instanceof CachedGenerationRequest && that.digest === this.digest;
  }

  [Hash.symbol](): number {
    return Hash.string(this.digest);
  }
}

/**
 * The prompt text each provider sends for a commit message. Providers build it
 * with this same builder, so the digest covers exactly what the model sees.
 */
const commitMessagePromptFor = (input: CommitMessageGenerationInput): string =>
  buildCommitMessagePrompt({
    branch: input.branch,
    stagedSummary: input.stagedSummary,
    stagedPatch: input.stagedPatch,
    includeBranch: input.includeBranch === true,
    policy: input.policy,
  }).prompt;

/** The prompt text each provider sends for change request content. */
const prContentPromptFor = (input: PrContentGenerationInput): string =>
  buildPrContentPrompt({
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    commitSummary: input.commitSummary,
    diffSummary: input.diffSummary,
    diffPatch: input.diffPatch,
    policy: input.policy,
    changeRequestTemplate: input.changeRequestTemplate,
  }).prompt;

/** Route and tuning options, ordered so equal selections hash equally. */
const modelSelectionDigest = (selection: ModelSelection): string => {
  const options = (selection.options ?? []).map((option) => `${option.id}=${option.value}`).sort();
  return `${selection.instanceId}\n${selection.model}\n${options.join("\n")}`;
};

/** sha256 over the operation, the model selection and the full prompt text. */
const generationCacheDigest = (
  operation: "generateCommitMessage" | "generatePrContent",
  modelSelection: ModelSelection,
  prompt: string,
): string =>
  NodeCrypto.createHash("sha256")
    .update(operation)
    .update("\0")
    .update(modelSelectionDigest(modelSelection))
    .update("\0")
    .update(prompt)
    .digest("hex");

const makeGenerationCache = <A>() =>
  Cache.makeWith<CachedGenerationRequest<A>, A, TextGenerationError>(
    (request) => request.generate,
    {
      capacity: GENERATION_CACHE_CAPACITY,
      // Failures and interrupts are never cached, so the next request retries.
      timeToLive: (exit) => (Exit.isSuccess(exit) ? GENERATION_CACHE_TTL : Duration.zero),
    },
  );

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const commitMessageCache = yield* makeGenerationCache<CommitMessageGenerationResult>();
  const prContentCache = yield* makeGenerationCache<PrContentGenerationResult>();

  const generateCommitMessage = (
    input: CommitMessageGenerationInput,
  ): Effect.Effect<CommitMessageGenerationResult, TextGenerationError> =>
    Cache.get(
      commitMessageCache,
      new CachedGenerationRequest(
        generationCacheDigest(
          "generateCommitMessage",
          input.modelSelection,
          commitMessagePromptFor(input),
        ),
        resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
        ),
      ),
    );

  const generatePrContent = (
    input: PrContentGenerationInput,
  ): Effect.Effect<PrContentGenerationResult, TextGenerationError> =>
    Cache.get(
      prContentCache,
      new CachedGenerationRequest(
        generationCacheDigest("generatePrContent", input.modelSelection, prContentPromptFor(input)),
        resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
          Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
        ),
      ),
    );

  return TextGeneration.of({
    generateCommitMessage,
    generatePrContent,
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* textGeneration.generateThreadTitle({ ...input, linkedContext });
          }),
        ),
      ),
    generateWorkLessons: (input) =>
      resolveInstance(registry, "generateWorkLessons", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateWorkLessons(input)),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
