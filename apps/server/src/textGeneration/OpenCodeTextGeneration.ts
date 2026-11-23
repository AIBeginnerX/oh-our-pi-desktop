import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  TextGenerationError,
  type ChatAttachment,
  type ModelSelection,
  type OpenCodeSettings,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkLessonsPrompt,
  buildSideAnswerPrompt,
  buildMemoryTidyPrompt,
} from "./TextGenerationPrompts.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";
import { makeOpenCode2Client } from "../provider/opencode2/OpenCode2Client.ts";
import {
  scopedOpenCodeModelIssue,
  type OpenCodeProviderScope,
} from "../provider/openCodeProviderScope.ts";

const OpenCodeTextGenerationOperation = Schema.Literals([
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateWorkLessons",
  "generateSideAnswer",
  "generateMemoryTidy",
]);

type OpenCodeTextGenerationOperation = typeof OpenCodeTextGenerationOperation.Type;

const openCodeTextGenerationErrorContext = {
  operation: OpenCodeTextGenerationOperation,
  cwd: Schema.String,
};

export class OpenCodeTextGenerationSessionRequestError extends Schema.TaggedError<OpenCodeTextGenerationSessionRequestError>()(
  "OpenCodeTextGenerationSessionRequestError",
  {
    ...openCodeTextGenerationErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode session creation request failed for ${this.operation} in ${this.cwd}.`;
  }
}

export class OpenCodeTextGenerationSessionPayloadError extends Schema.TaggedError<OpenCodeTextGenerationSessionPayloadError>()(
  "OpenCodeTextGenerationSessionPayloadError",
  openCodeTextGenerationErrorContext,
) {
  override get message(): string {
    return `OpenCode session.create returned no session payload for ${this.operation} in ${this.cwd}.`;
  }
}

const openCodePromptErrorContext = {
  ...openCodeTextGenerationErrorContext,
  sessionId: Schema.String,
  providerId: Schema.String,
  modelId: Schema.String,
};

export class OpenCodeTextGenerationPromptRequestError extends Schema.TaggedError<OpenCodeTextGenerationPromptRequestError>()(
  "OpenCodeTextGenerationPromptRequestError",
  {
    ...openCodePromptErrorContext,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `OpenCode prompt request failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}).`;
  }
}

export class OpenCodeTextGenerationPromptResponseError extends Schema.TaggedError<OpenCodeTextGenerationPromptResponseError>()(
  "OpenCodeTextGenerationPromptResponseError",
  {
    ...openCodePromptErrorContext,
    providerErrorName: Schema.optional(Schema.String),
    providerMessage: Schema.String,
  },
) {
  override get message(): string {
    const providerError = this.providerErrorName ? ` ${this.providerErrorName}` : "";
    return `OpenCode prompt${providerError} failed for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}): ${this.providerMessage}`;
  }
}

export class OpenCodeTextGenerationEmptyOutputError extends Schema.TaggedError<OpenCodeTextGenerationEmptyOutputError>()(
  "OpenCodeTextGenerationEmptyOutputError",
  {
    ...openCodePromptErrorContext,
    responsePartCount: NonNegativeInt,
    textPartCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `OpenCode returned empty output for ${this.operation} in ${this.cwd} using ${this.providerId}/${this.modelId} (session ${this.sessionId}, ${this.responsePartCount} response parts, ${this.textPartCount} text parts).`;
  }
}

interface OpenCodePromptFailure {
  readonly name?: string;
  readonly message: string;
}

interface OpenCodeTextPart {
  readonly type: "text";
  readonly text: string;
}

function getOpenCodePromptFailure(error: unknown): OpenCodePromptFailure | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const name =
    "name" in error && typeof error.name === "string" && error.name.trim().length > 0
      ? error.name.trim()
      : undefined;
  const message =
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
      ? error.data.message.trim()
      : "";
  if (message.length > 0) {
    return {
      ...(name ? { name } : {}),
      message,
    };
  }

  if (name) {
    return { name, message: name };
  }

  return null;
}

function isOpenCodeTextPart(part: unknown): part is OpenCodeTextPart {
  return (
    part !== null &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function getOpenCodeTextResponse(parts: ReadonlyArray<unknown> | undefined): string {
  return (parts ?? [])
    .filter(isOpenCodeTextPart)
    .map((part) => part.text)
    .join("")
    .trim();
}

export interface OpenCode2TextGenerationRoute {
  /** Whether the configured OpenCode currently speaks the 2.x protocol. */
  readonly isV2: Effect.Effect<boolean>;
  readonly serverOwner: OpenCodeServerOwner.OpenCodeServerOwner["Service"];
}

export const makeOpenCodeTextGeneration = Effect.fn("makeOpenCodeTextGeneration")(function* (
  openCodeSettings: OpenCodeSettings,
  providerScope?: OpenCodeProviderScope,
  openCode2?: OpenCode2TextGenerationRoute,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;

  const runOpenCodeJson = Effect.fn("runOpenCodeJson")(function* <S extends Schema.Top>(input: {
    readonly operation: OpenCodeTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
    readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  }) {
    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    const parsedModel = OpenCodeRuntime.parseOpenCodeModelSlug(input.modelSelection.model);
    if (!parsedModel) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "OpenCode model selection must use the 'provider/model' format.",
      });
    }
    const scopeIssue = scopedOpenCodeModelIssue(
      providerScope,
      parsedModel.providerID,
      openCodeSettings.serverUrl,
    );
    if (scopeIssue) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: scopeIssue,
      });
    }

    const fileParts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
    });

    const runAgainstServer = Effect.fn("runOpenCodeJson.runAgainstServer")(
      function* (
        server: Pick<
          OpenCodeRuntime.OpenCodeServerConnection,
          "url" | "serverPassword" | "version"
        >,
      ) {
        const client = openCodeRuntime.createOpenCodeSdkClient({
          baseUrl: server.url,
          directory: input.cwd,
          ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        });
        const session = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              title: `OOP ${input.operation}`,
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationSessionRequestError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
            }),
        });
        if (!session.data) {
          return yield* new OpenCodeTextGenerationSessionPayloadError({
            operation: input.operation,
            cwd: input.cwd,
          });
        }
        const selectedAgent = getModelSelectionStringOptionValue(input.modelSelection, "agent");
        const selectedVariant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const promptContext = {
          operation: input.operation,
          cwd: input.cwd,
          sessionId: session.data.id,
          providerId: parsedModel.providerID,
          modelId: parsedModel.modelID,
        };

        const result = yield* Effect.tryPromise({
          try: () =>
            client.session.prompt({
              sessionID: promptContext.sessionId,
              model: parsedModel,
              ...(selectedAgent ? { agent: selectedAgent } : {}),
              ...(selectedVariant ? { variant: selectedVariant } : {}),
              parts: [{ type: "text", text: input.prompt }, ...fileParts],
            }),
          catch: (cause) =>
            new OpenCodeTextGenerationPromptRequestError({
              ...promptContext,
              cause,
            }),
        }).pipe(
          Effect.ensuring(
            OpenCodeRuntime.runOpenCodeSdk("session.delete", (signal) =>
              client.session.delete({ sessionID: promptContext.sessionId }, { signal }),
            ).pipe(Effect.interruptible, Effect.timeoutOption("3 seconds"), Effect.ignore),
          ),
        );
        const promptFailure = getOpenCodePromptFailure(result.data?.info?.error);
        if (promptFailure) {
          return yield* new OpenCodeTextGenerationPromptResponseError({
            ...promptContext,
            ...(promptFailure.name ? { providerErrorName: promptFailure.name } : {}),
            providerMessage: promptFailure.message,
          });
        }
        const responseParts = result.data?.parts ?? [];
        const rawText = getOpenCodeTextResponse(responseParts);
        if (rawText.length === 0) {
          return yield* new OpenCodeTextGenerationEmptyOutputError({
            ...promptContext,
            responsePartCount: responseParts.length,
            textPartCount: responseParts.filter(isOpenCodeTextPart).length,
          });
        }
        return rawText;
      },
      Effect.catchTags({
        OpenCodeTextGenerationSessionRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationSessionPayloadError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.create returned no session payload.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptRequestError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode session.prompt request failed.",
              cause,
            }),
          ),
        OpenCodeTextGenerationPromptResponseError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: cause.providerMessage,
              cause,
            }),
          ),
        OpenCodeTextGenerationEmptyOutputError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: cause.operation,
              detail: "OpenCode returned empty output.",
              cause,
            }),
          ),
      }),
    );

    // OpenCode 2 uses a throwaway session to hold the model and permissions.
    const runAgainstV2Server = (
      server: Pick<OpenCodeRuntime.OpenCodeServerConnection, "url" | "serverPassword">,
    ) =>
      Effect.gen(function* () {
        const client = makeOpenCode2Client({
          baseUrl: server.url,
          password: server.serverPassword ?? "",
        });
        const variant = getModelSelectionStringOptionValue(input.modelSelection, "variant");
        const files: Array<{ uri: string; name: string }> = [];
        if (fileParts.length > 0) {
          const root = yield* fs
            .realPath(serverConfig.attachmentsDir)
            .pipe(Effect.orElseSucceed(() => null));
          if (root) {
            for (const part of fileParts) {
              const file = yield* path.fromFileUrl(new URL(part.url)).pipe(Effect.orDie);
              const resolved = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => null));
              if (resolved?.startsWith(`${root}${path.sep}`)) {
                files.push({
                  uri: (yield* path.toFileUrl(resolved).pipe(Effect.orDie)).href,
                  name: part.filename ?? path.basename(file),
                });
              }
            }
          }
        }
        const runSession = Effect.fn("runOpenCodeJson.v2Session")(function* (withImages: boolean) {
          const session = yield* Effect.acquireRelease(
            OpenCodeRuntime.runOpenCodeSdk("session.create", (signal) =>
              client.session.create(
                {
                  location: { directory: input.cwd },
                  title: `OOP ${input.operation}`,
                  model: {
                    providerID: parsedModel.providerID,
                    id: parsedModel.modelID,
                    ...(variant ? { variant } : {}),
                  },
                  permissions: [{ action: "*", resource: "*", effect: "deny" }],
                },
                { signal },
              ),
            ),
            (session) =>
              OpenCodeRuntime.runOpenCodeSdk("session.remove", (signal) =>
                client.session.remove({ sessionID: session.id }, { signal }),
              ).pipe(Effect.interruptible, Effect.timeoutOption("3 seconds"), Effect.ignore),
          );
          const sessionID = session.id;
          if (!withImages) {
            const generated = yield* OpenCodeRuntime.runOpenCodeSdk("session.generate", (signal) =>
              client.session.generate({ sessionID, prompt: input.prompt }, { signal }),
            );
            return generated.text.trim();
          }
          return yield* Effect.gen(function* () {
            yield* OpenCodeRuntime.runOpenCodeSdk("session.prompt", (signal) =>
              client.session.prompt({ sessionID, text: input.prompt, files }, { signal }),
            );
            yield* OpenCodeRuntime.runOpenCodeSdk("session.wait", (signal) =>
              client.session.wait({ sessionID }, { signal }),
            );
            const messages = yield* OpenCodeRuntime.runOpenCodeSdk("message.list", (signal) =>
              client.message.list(
                { sessionID, type: "assistant", order: "desc", limit: 1 },
                { signal },
              ),
            );
            const answer = messages.data[0];
            return answer?.type === "assistant" ? getOpenCodeTextResponse(answer.content) : "";
          }).pipe(
            Effect.catchTag("OpenCodeRuntimeError", () => Effect.succeed("")),
            Effect.timeoutOption("60 seconds"),
            Effect.map((result) => (result._tag === "Some" ? result.value : "")),
          );
        }, Effect.scoped);
        const imageText = files.length > 0 ? yield* runSession(true) : "";
        const validImage =
          imageText.length > 0 &&
          (yield* decodeOutput(extractJsonObject(imageText)).pipe(
            Effect.map(() => true),
            Effect.catchTag("SchemaError", () => Effect.succeed(false)),
          ));
        const text = validImage ? imageText : yield* runSession(false);
        if (text.length === 0) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "OpenCode returned empty output.",
          });
        }
        return text;
      });
    const useV2 = openCode2 !== undefined && (yield* openCode2.isV2);

    const serverOutput = useV2
      ? openCodeSettings.serverUrl.length > 0
        ? runAgainstV2Server({
            url: openCodeSettings.serverUrl,
            serverPassword: openCodeSettings.serverPassword,
          })
        : openCode2.serverOwner.withServer(runAgainstV2Server)
      : openCodeSettings.serverUrl.length > 0
        ? openCodeRuntime
            .connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              directory: input.cwd,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
            })
            .pipe(Effect.flatMap(runAgainstServer), Effect.scoped)
        : serverOwner.withServer(runAgainstServer);
    const rawOutput = yield* serverOutput.pipe(
      Effect.catchTags({
        OpenCodeRuntimeError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
              cause,
            }),
          ),
      }),
    );

    return yield* decodeOutput(extractJsonObject(rawOutput)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OpenCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OpenCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OpenCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OpenCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });
      const generated = yield* runOpenCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        attachments: input.attachments,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  const generateSideAnswer: NonNullable<
    TextGeneration.TextGeneration["Service"]["generateSideAnswer"]
  > = (input) => {
    const { prompt, outputSchema } = buildSideAnswerPrompt(input);
    return runOpenCodeJson({
      operation: "generateSideAnswer",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    }).pipe(
      Effect.mapError(
        () =>
          new TextGenerationError({
            operation: "generateSideAnswer",
            detail: "Could not generate an isolated side answer.",
          }),
      ),
    );
  };

  const generateWorkLessons: TextGeneration.TextGeneration["Service"]["generateWorkLessons"] =
    Effect.fn("OpenCodeTextGeneration.generateWorkLessons")(function* (input) {
      const { prompt, outputSchema } = buildWorkLessonsPrompt({ digest: input.digest });
      return yield* runOpenCodeJson({
        operation: "generateWorkLessons",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
    });

  const generateMemoryTidy: TextGeneration.TextGeneration["Service"]["generateMemoryTidy"] =
    Effect.fn("OpenCodeTextGeneration.generateMemoryTidy")(function* (input) {
      const { prompt, outputSchema } = buildMemoryTidyPrompt({ digest: input.digest });
      return yield* runOpenCodeJson({
        operation: "generateMemoryTidy",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateSideAnswer,
    generateWorkLessons,
    generateMemoryTidy,
  } satisfies TextGeneration.TextGeneration["Service"];
});
