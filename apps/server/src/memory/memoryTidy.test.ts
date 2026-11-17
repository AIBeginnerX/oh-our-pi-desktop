import { describe, expect, it } from "vite-plus/test";
import type { ProjectMemory } from "@t3tools/contracts";
import { buildMemoryTidyInput, selectMemoryTidies, selectTidyMemories } from "./memoryTidy.ts";
const memories = [1, 2, 3].map((i) => ({
  memoryId: `private-${i}`,
  title: `Title ${i}`,
  body: "Body",
  version: 1,
  kind: "fact",
  updatedAt: "2026-01-01",
  validUntil: null,
})) as ProjectMemory[];
describe("memory tidy validation", () => {
  it("labels text without ids and filters sensitive and pending memories", () => {
    expect(buildMemoryTidyInput(memories)).not.toContain("private-");
    expect(
      selectTidyMemories(
        [...memories, { ...memories[0]!, title: "-----BEGIN PRIVATE KEY-----" }],
        new Set(["private-2"]),
      ),
    ).toHaveLength(2);
  });
  it("accepts merges, excludes reused and unknown labels", () => {
    expect(
      selectMemoryTidies(
        {
          suggestions: [
            {
              action: "merge",
              memories: ["M1", "M2"],
              title: "Combined",
              body: "Combined body",
              reason: "Duplicate",
            },
            { action: "delete", memories: ["M1"], reason: "Old" },
            { action: "delete", memories: ["M9"], reason: "Old" },
          ],
        },
        memories,
      ),
    ).toHaveLength(1);
  });
  it("rejects repeated labels, unchanged updates and delete text; respects cap", () => {
    const suggestions = [
      { action: "merge" as const, memories: ["M1", "M1"], title: "X", body: "X", reason: "X" },
      { action: "update" as const, memories: ["M1"], title: "Title 1", body: "Body", reason: "X" },
      { action: "delete" as const, memories: ["M2"], body: "X", reason: "X" },
    ];
    expect(selectMemoryTidies({ suggestions }, memories)).toEqual([]);
    expect(
      selectMemoryTidies(
        {
          suggestions: memories.map((_, i) => ({
            action: "delete",
            memories: [`M${i + 1}`],
            reason: "Outdated",
          })),
        },
        memories,
        4,
      ),
    ).toHaveLength(1);
  });
});
