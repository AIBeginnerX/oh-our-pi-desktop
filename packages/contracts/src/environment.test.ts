import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeDescriptorExit = Schema.decodeUnknownExit(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("requires an advertised required-worktree bootstrap capability", () => {
    expect(decodeDescriptor(descriptor).capabilities.requiredWorktreeBootstrap).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, requiredWorktreeBootstrap: true },
      }).capabilities.requiredWorktreeBootstrap,
    ).toBe(true);
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });

  it("treats a legacy projectMemory capability without threadRecovery as undefined", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, projectMemory: { manage: true, send: false } },
      }).capabilities.projectMemory,
    ).toEqual({ manage: true, send: false });
  });

  it("preserves an advertised projectMemory threadRecovery flag", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectMemory: { manage: true, send: true, threadRecovery: true },
        },
      }).capabilities.projectMemory,
    ).toEqual({ manage: true, send: true, threadRecovery: true });
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectMemory: { manage: false, send: true, threadRecovery: false },
        },
      }).capabilities.projectMemory,
    ).toEqual({ manage: false, send: true, threadRecovery: false });
  });

  it("preserves advertised projectMemory sendDriverKinds and treats a missing list as empty", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectMemory: {
            manage: true,
            send: true,
            threadRecovery: true,
            sendDriverKinds: ["claudeAgent"],
          },
        },
      }).capabilities.projectMemory,
    ).toEqual({
      manage: true,
      send: true,
      threadRecovery: true,
      sendDriverKinds: ["claudeAgent"],
    });
    // Servers whose allowlist is empty omit the list entirely, and a
    // descriptor from a server that predates the field decodes with none.
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectMemory: { manage: true, send: false, threadRecovery: true },
        },
      }).capabilities.projectMemory?.sendDriverKinds,
    ).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectMemory: { manage: true, send: true },
        },
      }).capabilities.projectMemory?.sendDriverKinds,
    ).toBeUndefined();
  });

  it("rejects malformed provider driver kinds in projectMemory sendDriverKinds", () => {
    expect(
      Exit.isFailure(
        decodeDescriptorExit({
          ...descriptor,
          capabilities: {
            ...descriptor.capabilities,
            projectMemory: { manage: true, send: true, sendDriverKinds: ["bad kind!"] },
          },
        }),
      ),
    ).toBe(true);
  });

  it("treats a missing projectSkills capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.projectSkills).toBeUndefined();
  });

  it("preserves an advertised projectSkills manage flag", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, projectSkills: { manage: true } },
      }).capabilities.projectSkills,
    ).toEqual({ manage: true });
  });

  it("treats a missing projectSkills trial flag as unsupported under version skew", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, projectSkills: { manage: true } },
      }).capabilities.projectSkills?.trial,
    ).toBeUndefined();
  });

  it("preserves an advertised projectSkills trial flag", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectSkills: { manage: true, trial: true },
        },
      }).capabilities.projectSkills,
    ).toEqual({ manage: true, trial: true });
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectSkills: { manage: true, trial: false },
        },
      }).capabilities.projectSkills,
    ).toEqual({ manage: true, trial: false });
  });

  it("rejects a non-boolean projectSkills trial flag", () => {
    expect(
      Exit.isFailure(
        decodeDescriptorExit({
          ...descriptor,
          capabilities: {
            ...descriptor.capabilities,
            projectSkills: { manage: true, trial: "yes" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("decodes projectSkills alongside an intact projectMemory capability", () => {
    const capabilities = decodeDescriptor({
      ...descriptor,
      capabilities: {
        ...descriptor.capabilities,
        projectMemory: { manage: true, send: false, threadRecovery: true },
        projectSkills: { manage: true },
      },
    }).capabilities;
    expect(capabilities.projectSkills).toEqual({ manage: true });
    expect(capabilities.projectMemory).toEqual({ manage: true, send: false, threadRecovery: true });
  });

  it("treats absent projectSkills lifecycle and use flags as unsupported", () => {
    const skills = decodeDescriptor({
      ...descriptor,
      capabilities: { ...descriptor.capabilities, projectSkills: { manage: true, trial: true } },
    }).capabilities.projectSkills;
    expect(skills?.lifecycle).toBeUndefined();
    expect(skills?.use).toBeUndefined();
  });

  it("preserves advertised projectSkills lifecycle and use flags", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectSkills: { manage: true, lifecycle: true, use: false },
        },
      }).capabilities.projectSkills,
    ).toEqual({ manage: true, lifecycle: true, use: false });
  });

  it("treats absent projectSkills generatedDraft as unsupported", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, projectSkills: { manage: true } },
      }).capabilities.projectSkills?.generatedDraft,
    ).toBeUndefined();
  });

  it("preserves an advertised projectSkills generatedDraft flag", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          projectSkills: { manage: true, generatedDraft: true },
        },
      }).capabilities.projectSkills,
    ).toEqual({ manage: true, generatedDraft: true });
  });
});
