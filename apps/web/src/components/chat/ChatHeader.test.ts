import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveRenameCommit,
  shouldShowOpenInPicker,
  shouldShowSkillTrialEntry,
  shouldShowSkillUseEntry,
} from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});

describe("shouldShowSkillUseEntry", () => {
  it("stays dormant without the use capability", () => {
    expect(shouldShowSkillUseEntry({ useCapability: false, projectId: "project-a" })).toBe(false);
  });

  it("needs a project and does not imply trial", () => {
    expect(shouldShowSkillUseEntry({ useCapability: true, projectId: null })).toBe(false);
    expect(shouldShowSkillUseEntry({ useCapability: true, projectId: "project-a" })).toBe(true);
  });
});

describe("shouldShowSkillTrialEntry", () => {
  it("stays dormant without the trial capability, even with a project", () => {
    expect(shouldShowSkillTrialEntry({ trialCapability: false, projectId: "project-a" })).toBe(
      false,
    );
  });

  it("needs a project to freeze the send scope to", () => {
    expect(shouldShowSkillTrialEntry({ trialCapability: true, projectId: null })).toBe(false);
  });

  it("shows the entry when the capability is advertised and a project exists", () => {
    expect(shouldShowSkillTrialEntry({ trialCapability: true, projectId: "project-a" })).toBe(true);
  });
});
