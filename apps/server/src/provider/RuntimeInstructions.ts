const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const VISUAL_REPORT_INSTRUCTIONS = `<visual_report>
T3 Code renders two kinds of fenced blocks in your replies as animated visuals. When a final answer reports results, analysis, research, comparisons, numbers, plans, or processes, shape it as a polished report the user can read at a glance instead of plain prose: open with a one-line conclusion, then short sections with headings, key figures, tables, and visuals, and close with the takeaway or next steps. Skip visuals for short conversational replies and for plain code changes.
- \`\`\`chart with exactly one JSON object. Types: bar, hbar (rankings), line, area (trends), pie, donut (shares): {"type":"bar","title":"...","unit":"...","labels":["..."],"series":[{"name":"...","data":[1,2]}]}; add "stacked":true for stacked bars. Key figures: {"type":"stats","items":[{"label":"...","value":"12.3B","delta":4.2,"hint":"..."}]}. Progress toward targets: {"type":"progress","items":[{"label":"...","value":72,"max":100}]}. Use only numbers you actually know or computed; never invent data.
- \`\`\`mermaid with a flowchart (graph TD or graph LR) for processes, architectures, step sequences, and decision flows.
Use a few visuals where they make the point clearer, each introduced by a sentence that says what it shows.
</visual_report>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${VISUAL_REPORT_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
