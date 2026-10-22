import { describe, expect, it } from "vite-plus/test";

import { firstRealUserRequest } from "./AgentSessionUserRequest.ts";

describe("OoP harness blocks", () => {
  it("takes the title from the user's text after an injected crew brief or memory note", () => {
    const text = [
      "<oop_crew>",
      "OOP Crew is on for this chat. You are the brain.",
      "</oop_crew>",
      "<recalled-memory>",
      "- prefers Korean replies",
      "</recalled-memory>",
      "Fix the login redirect",
    ].join("\n");
    expect(firstRealUserRequest(text)).toBe("Fix the login redirect");
  });
});
