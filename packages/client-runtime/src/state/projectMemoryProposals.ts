import type {
  ProjectMemoryProposal,
  ProjectMemoryProposalAnalysis,
  ThreadId,
} from "@t3tools/contracts";

/**
 * What a client may do with a pending proposal. Agent proposals and work
 * analyser suggestions share one list; this keeps the rules for telling them
 * apart in one place for every client.
 */
export interface ProjectMemoryProposalView {
  readonly source: "agent" | "analyser";
  /** A skill suggestion is kept from its thread's skill draft, not saved as a memory. */
  readonly target: "memory" | "skill";
  readonly canApprove: boolean;
  /** Distinct threads the suggestion rests on, in citation order. */
  readonly evidenceThreadIds: ReadonlyArray<ThreadId>;
  /** Existing memories shown beside the text so the user decides; never merged. */
  readonly related: ProjectMemoryProposalAnalysis["related"];
}

export function projectMemoryProposalView(
  proposal: ProjectMemoryProposal,
): ProjectMemoryProposalView {
  const analysis = proposal.analysis;
  if (analysis === undefined) {
    return {
      source: "agent",
      target: "memory",
      canApprove: true,
      evidenceThreadIds: [],
      related: [],
    };
  }
  return {
    source: "analyser",
    target: analysis.target,
    canApprove: analysis.target === "memory",
    evidenceThreadIds: [...new Set(analysis.evidence.map((item) => item.threadId))],
    related: analysis.related,
  };
}

/**
 * Whether the "Analyse recent work" action is offered: the server must serve
 * it and the user must have switched it on. `unsupported` is an older server.
 */
export function projectMemoryAnalyserState(
  config:
    | {
        readonly environment: {
          readonly capabilities: {
            readonly projectMemory?: { readonly analyser?: boolean | undefined } | undefined;
          };
        };
        readonly settings: {
          readonly projectMemoryAnalyser?: boolean | undefined;
        };
      }
    | null
    | undefined,
): "unsupported" | "off" | "on" {
  if (config?.environment.capabilities.projectMemory?.analyser !== true) return "unsupported";
  return config.settings.projectMemoryAnalyser === true ? "on" : "off";
}
