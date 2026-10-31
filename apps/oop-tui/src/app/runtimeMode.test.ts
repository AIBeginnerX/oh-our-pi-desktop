import { describe, expect, it } from "vite-plus/test";

import {
  parseRuntimeMode,
  RUNTIME_MODES,
  runtimeModeLabel,
  runtimeModeWords,
} from "./runtimeMode.ts";

describe("runtime modes", () => {
  it("names the four modes the way the desktop app does", () => {
    expect(RUNTIME_MODES.map((entry) => entry.value)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(RUNTIME_MODES.map((entry) => runtimeModeLabel(entry.value))).toEqual([
      "승인 필요",
      "편집 자동 승인",
      "자동",
      "전체 접근",
    ]);
  });

  it("reads a value, an alias, or the label without its spaces", () => {
    expect(parseRuntimeMode("approval")).toBe("approval-required");
    expect(parseRuntimeMode("edits")).toBe("auto-accept-edits");
    expect(parseRuntimeMode("AUTO")).toBe("auto");
    expect(parseRuntimeMode("full")).toBe("full-access");
    expect(parseRuntimeMode("full-access")).toBe("full-access");
    expect(parseRuntimeMode("편집자동승인")).toBe("auto-accept-edits");
    expect(parseRuntimeMode("전체접근")).toBe("full-access");
  });

  it("answers null for anything else", () => {
    expect(parseRuntimeMode("")).toBeNull();
    expect(parseRuntimeMode("yolo")).toBeNull();
  });

  it("lists the short words for the error message", () => {
    expect(runtimeModeWords()).toBe("approval, edits, auto, full");
  });
});
