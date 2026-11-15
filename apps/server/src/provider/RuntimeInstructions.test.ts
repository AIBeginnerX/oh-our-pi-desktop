import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("points at the diagram-design skill in one sentence for diagrams a flowchart cannot carry", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    const line = instructions.split("\n").find((entry) => entry.includes("diagram-design"));
    expect(line).toBeDefined();
    const pointer = line!.slice(line!.indexOf("For a diagram a flowchart cannot carry"));
    expect(pointer).toBe(
      "For a diagram a flowchart cannot carry (architecture, sequence, ER, data flow), when the diagram-design skill is available, draw it with that skill, export an SVG and embed it by absolute path.",
    );
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });

  it("adds the short project memory pointer only when asked", () => {
    const withMemory = buildRuntimeInstructions({ harness: "Codex", projectMemory: true });
    expect(withMemory).toContain("<project_memory>");
    expect(withMemory).toContain("memory_recall");
    expect(withMemory).toContain("memory_propose");
    expect(withMemory.endsWith("</project_memory>")).toBe(true);
    expect(buildRuntimeInstructions({ harness: "Cursor" })).not.toContain("project_memory");
    const added = withMemory.length - buildRuntimeInstructions({ harness: "Codex" }).length;
    expect(added).toBeLessThan(400);
  });

  it("appends the user's standing instructions with their newlines intact", () => {
    const text = "Always reply in Korean.\n\n- Prefer focused tests.\n- No repo-wide checks.";
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      projectMemory: true,
      agentInstructions: `  ${text}  `,
    });
    expect(instructions).toContain(
      "<user_instructions>\nThe user wrote these standing instructions for every agent they run in OOP. Follow them unless a message in this conversation says otherwise.\n\n",
    );
    expect(instructions).toContain(`\n\n${text}\n</user_instructions>`);
    expect(instructions.endsWith("</user_instructions>")).toBe(true);
    expect(instructions.indexOf("<project_memory>")).toBeLessThan(
      instructions.indexOf("<user_instructions>"),
    );
  });

  it.each([undefined, "", "   \n\t  "])(
    "adds nothing for empty agent instructions %s",
    (agentInstructions) => {
      const instructions = buildRuntimeInstructions({ harness: "Codex", agentInstructions });
      expect(instructions).not.toContain("<user_instructions>");
      expect(instructions).toBe(buildRuntimeInstructions({ harness: "Codex" }));
    },
  );
});
