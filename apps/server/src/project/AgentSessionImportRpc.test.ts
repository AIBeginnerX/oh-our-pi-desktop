import { describe, expect, it } from "@effect/vitest";
import {
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionScanError,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Rpc } from "effect/unstable/rpc";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import { toAgentSessionImportRpcCause } from "./AgentSessionImportRpc.ts";

const CANARY = "/private/raw-internal/CANARY-9f8e6d5c";
const PUBLIC_FAILURE = "Agent session import could not complete.";
const PUBLIC_DEFECT = "Agent session import failed unexpectedly.";

const AnnotationKey = Context.Reference<string>("AgentSessionImportRpc.test/annotation", {
  defaultValue: () => "unset",
});

const importRpc = WsRpcGroup.requests.get(WS_METHODS.agentSessionsImport);
if (importRpc === undefined) {
  throw new Error("WsRpcGroup does not declare the agentSessions.import request.");
}
// Same schema and JSON codec the websocket server uses for RPC exits
// (Rpc.exitSchema + RpcSerialization.layerJson's toCodecJson codecFor).
const importExitCodec = Schema.toCodecJson(Rpc.exitSchema(importRpc));
const encodeExit = Schema.encodeUnknownSync(importExitCodec);
const decodeExit = Schema.decodeUnknownSync(importExitCodec);
// Same squash input encoding the server's fatal frame path composes:
// sendDefect(Cause.squash(cause)) encoded by codecFor(Schema.Defect()).
// This proves the encoder boundary only; it does not run a live RpcServer.
const encodeFatalDefect = Schema.encodeSync(Schema.toCodecJson(Schema.Defect()));

const failReasonOf = (error: unknown, label: string) =>
  Cause.makeFailReason(error).annotate(Context.make(AnnotationKey, label));

const dieReasonOf = (defect: unknown, label: string) =>
  Cause.makeDieReason(defect).annotate(Context.make(AnnotationKey, label));

const failReasonAt = (cause: Cause.Cause<unknown>, index: number) => {
  const reason = cause.reasons.at(index);
  expect(reason?._tag).toBe("Fail");
  return reason !== undefined && Cause.isFailReason(reason) ? reason : undefined;
};

const dieReasonAt = (cause: Cause.Cause<unknown>, index: number) => {
  const reason = cause.reasons.at(index);
  expect(reason?._tag).toBe("Die");
  return reason !== undefined && Cause.isDieReason(reason) ? reason : undefined;
};

const expectScanError = (error: unknown, operation: AgentSessionScanError["operation"]) => {
  expect(error).toBeInstanceOf(AgentSessionScanError);
  if (error instanceof AgentSessionScanError) {
    expect(error.operation).toBe(operation);
    expect(error.cause).toBe(PUBLIC_FAILURE);
  }
};

describe("toAgentSessionImportRpcCause", () => {
  it("normalizes every typed failure and keeps the wire payload free of internal details", () => {
    const projectId = ProjectId.make("project-1");
    const persistenceError = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.listBindings:list",
      detail: `listBindings read failed at ${CANARY}`,
      cause: new Error(CANARY),
    });
    const rawScanError = new AgentSessionScanError({
      operation: "read-settings",
      cause: new Error(`scan blew up at ${CANARY}`),
    });
    const notFound = new AgentSessionImportProjectNotFoundError({ projectId });
    const changed = new AgentSessionImportProjectChangedError({ projectId });
    const invariantError = new OrchestrationCommandInvariantError({
      commandType: "thread.create",
      detail: `dispatch rejected at ${CANARY}`,
      cause: new Error(CANARY),
    });
    const reasons = [
      failReasonOf(persistenceError, "persistence"),
      failReasonOf(rawScanError, "scan"),
      failReasonOf(notFound, "not-found"),
      failReasonOf(changed, "changed"),
      failReasonOf(invariantError, "invariant"),
    ];
    const interruptReason = Cause.makeInterruptReason(7);
    const internalCause = Cause.fromReasons([...reasons, interruptReason]);

    const mapped = toAgentSessionImportRpcCause(internalCause);

    // In-memory cause shape: same ordered reason kinds, same per-reason
    // annotation maps, same interrupt reason object.
    expect(mapped).not.toBe(internalCause);
    expect(mapped.reasons.map((reason) => reason._tag)).toEqual([
      "Fail",
      "Fail",
      "Fail",
      "Fail",
      "Fail",
      "Interrupt",
    ]);
    for (const [index, reason] of mapped.reasons.entries()) {
      expect(reason.annotations).toBe(internalCause.reasons.at(index)?.annotations);
    }
    const mappedInterrupt = mapped.reasons.at(-1);
    expect(mappedInterrupt).toBe(interruptReason);
    expect(interruptReason.fiberId).toBe(7);

    // Every Fail payload is normalized: public instances preserved, existing
    // ScanError keeps its operation with the fixed cause, all other typed
    // errors collapse to a read-projects ScanError.
    const mappedFails = reasons.map((_, index) => failReasonAt(mapped, index));
    expectScanError(mappedFails[0]?.error, "read-projects");
    expectScanError(mappedFails[1]?.error, "read-settings");
    expect(mappedFails[2]?.error).toBe(notFound);
    expect(mappedFails[3]?.error).toBe(changed);
    expectScanError(mappedFails[4]?.error, "read-projects");

    // Wire payload through the actual agentSessions.import exit codec: no raw
    // canary, path, or internal error tag survives, including the previous
    // ScanError.cause contents.
    const encoded = encodeExit(Exit.failCause(mapped));
    const wire = JSON.stringify(encoded);
    expect(wire).not.toContain(CANARY);
    expect(wire).not.toContain("ProviderSessionDirectoryPersistenceError");
    expect(wire).not.toContain("OrchestrationCommandInvariantError");
    expect(wire).toContain(PUBLIC_FAILURE);
    expect(encoded).toMatchObject({
      _tag: "Failure",
      cause: [
        {
          _tag: "Fail",
          error: {
            _tag: "AgentSessionScanError",
            operation: "read-projects",
            cause: PUBLIC_FAILURE,
          },
        },
        {
          _tag: "Fail",
          error: {
            _tag: "AgentSessionScanError",
            operation: "read-settings",
            cause: PUBLIC_FAILURE,
          },
        },
        { _tag: "Fail", error: { _tag: "AgentSessionImportProjectNotFoundError" } },
        { _tag: "Fail", error: { _tag: "AgentSessionImportProjectChangedError" } },
        {
          _tag: "Fail",
          error: {
            _tag: "AgentSessionScanError",
            operation: "read-projects",
            cause: PUBLIC_FAILURE,
          },
        },
        { _tag: "Interrupt", fiberId: 7 },
      ],
    });

    // Round-trip back through the same codec keeps failure order and the
    // interrupt fiber id intact.
    const decoded = decodeExit(JSON.parse(wire));
    expect(Exit.isFailure(decoded)).toBe(true);
    if (Exit.isFailure(decoded)) {
      expect(decoded.cause.reasons.map((reason) => reason._tag)).toEqual([
        "Fail",
        "Fail",
        "Fail",
        "Fail",
        "Fail",
        "Interrupt",
      ]);
      const decodedInterrupt = decoded.cause.reasons.at(-1);
      if (decodedInterrupt === undefined || !Cause.isInterruptReason(decodedInterrupt)) {
        throw new Error("expected a decoded Interrupt reason");
      }
      expect(decodedInterrupt.fiberId).toBe(7);
    }
  });

  it("normalizes defect payloads in a mixed cause through the actual rpc exit codec", () => {
    const projectId = ProjectId.make("project-3");
    const persistenceError = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.listBindings:list",
      detail: `listBindings read failed at ${CANARY}`,
      cause: new Error(CANARY),
    });
    // Two known Schema.Defect leak shapes: a nested Error cause chain and a
    // plain non-Error object. Both must be replaced, not serialized.
    const nestedDefect = new Error(`outer at ${CANARY}`, { cause: new Error(CANARY) });
    const objectDefect = { path: CANARY };
    const notFound = new AgentSessionImportProjectNotFoundError({ projectId });
    const interruptReason = Cause.makeInterruptReason(7);
    const internalCause = Cause.fromReasons([
      failReasonOf(persistenceError, "persistence"),
      dieReasonOf(nestedDefect, "die-nested"),
      failReasonOf(notFound, "not-found"),
      interruptReason,
      dieReasonOf(objectDefect, "die-object"),
    ]);

    const mapped = toAgentSessionImportRpcCause(internalCause);

    expect(mapped.reasons.map((reason) => reason._tag)).toEqual([
      "Fail",
      "Die",
      "Fail",
      "Interrupt",
      "Die",
    ]);
    // The failure/fatal branch is decided by these predicates; they must be
    // identical before and after normalization.
    expect(Cause.hasDies(mapped)).toBe(Cause.hasDies(internalCause));
    expect(Cause.hasInterrupts(mapped)).toBe(Cause.hasInterrupts(internalCause));
    expect(mapped.reasons.at(3)).toBe(interruptReason);

    const nestedDie = dieReasonAt(mapped, 1);
    const objectDie = dieReasonAt(mapped, 4);
    expect(nestedDie?.defect).toBe(PUBLIC_DEFECT);
    expect(objectDie?.defect).toBe(PUBLIC_DEFECT);
    expect(nestedDie).not.toBe(internalCause.reasons.at(1));
    expect(objectDie).not.toBe(internalCause.reasons.at(4));
    // Annotation entries are copied onto each replacement Die.
    if (nestedDie !== undefined) {
      expect(Context.get(Cause.reasonAnnotations(nestedDie), AnnotationKey)).toBe("die-nested");
    }
    if (objectDie !== undefined) {
      expect(Context.get(Cause.reasonAnnotations(objectDie), AnnotationKey)).toBe("die-object");
    }
    // Non-Die reasons from the intermediate cause pass through untouched:
    // the interrupt reason is the same object and the public NotFound error
    // instance is preserved.
    expectScanError(failReasonAt(mapped, 0)?.error, "read-projects");
    expect(failReasonAt(mapped, 2)?.error).toBe(notFound);

    const encoded = encodeExit(Exit.failCause(mapped));
    const wire = JSON.stringify(encoded);
    expect(wire).not.toContain(CANARY);
    expect(wire).toContain(PUBLIC_DEFECT);
    expect(encoded).toMatchObject({
      _tag: "Failure",
      cause: [
        {
          _tag: "Fail",
          error: {
            _tag: "AgentSessionScanError",
            operation: "read-projects",
            cause: PUBLIC_FAILURE,
          },
        },
        { _tag: "Die", defect: PUBLIC_DEFECT },
        { _tag: "Fail", error: { _tag: "AgentSessionImportProjectNotFoundError" } },
        { _tag: "Interrupt", fiberId: 7 },
        { _tag: "Die", defect: PUBLIC_DEFECT },
      ],
    });

    const decoded = decodeExit(JSON.parse(wire));
    expect(Exit.isFailure(decoded)).toBe(true);
    if (Exit.isFailure(decoded)) {
      expect(decoded.cause.reasons.map((reason) => reason._tag)).toEqual([
        "Fail",
        "Die",
        "Fail",
        "Interrupt",
        "Die",
      ]);
      for (const index of [1, 4]) {
        const reason = decoded.cause.reasons.at(index);
        expect(reason !== undefined && Cause.isDieReason(reason) && reason.defect).toBe(
          PUBLIC_DEFECT,
        );
      }
      const decodedInterrupt = decoded.cause.reasons.at(3);
      if (decodedInterrupt === undefined || !Cause.isInterruptReason(decodedInterrupt)) {
        throw new Error("expected a decoded Interrupt reason");
      }
      expect(decodedInterrupt.fiberId).toBe(7);
    }
  });

  it("replaces defect payloads while preserving the fatal-versus-exit branch", () => {
    const defect = new Error(`fatal at ${CANARY}`, { cause: new Error(CANARY) });

    // Interrupt-only causes have no Fail or Die payloads to normalize and are
    // returned as the same object.
    const interruptCause = Cause.interrupt(11);
    expect(toAgentSessionImportRpcCause(interruptCause)).toBe(interruptCause);

    // Die-only causes keep their fatal shape (hasDies && !hasInterrupts) but
    // the squashed defect is the fixed public string. Uses the same squash +
    // Schema.Defect JSON encoder the server's fatal frame composes; this does
    // not run a live RpcServer or prove socket-wide delivery.
    const dieOnly = Cause.die(defect);
    const mappedDieOnly = toAgentSessionImportRpcCause(dieOnly);
    expect(mappedDieOnly).not.toBe(dieOnly);
    expect(mappedDieOnly.reasons.at(0)).not.toBe(dieOnly.reasons.at(0));
    expect(dieReasonAt(mappedDieOnly, 0)?.defect).toBe(PUBLIC_DEFECT);
    expect(Cause.hasDies(mappedDieOnly)).toBe(true);
    expect(Cause.hasInterrupts(mappedDieOnly)).toBe(false);
    expect(encodeFatalDefect(Cause.squash(mappedDieOnly))).toBe(PUBLIC_DEFECT);

    // A Fail mixed with a Die still squashes to the first Fail — the already
    // normalized ScanError — so the fatal frame carries no raw detail either.
    const persistenceError = new ProviderSessionDirectoryPersistenceError({
      operation: "ProviderSessionDirectory.listBindings:list",
      detail: `listBindings read failed at ${CANARY}`,
      cause: new Error(CANARY),
    });
    const mappedMixed = toAgentSessionImportRpcCause(
      Cause.fromReasons([Cause.makeDieReason(defect), Cause.makeFailReason(persistenceError)]),
    );
    expect(Cause.hasDies(mappedMixed)).toBe(true);
    expect(Cause.hasInterrupts(mappedMixed)).toBe(false);
    const fatalEncoded = encodeFatalDefect(Cause.squash(mappedMixed));
    expect(JSON.stringify(fatalEncoded)).not.toContain(CANARY);
    expect(fatalEncoded).toMatchObject({
      message: "Failed to scan agent sessions during read-projects.",
      cause: PUBLIC_FAILURE,
    });
  });

  it("encodes a successful import exit with the same rpc codec", () => {
    const encoded = encodeExit(Exit.succeed({ importedCount: 2, skippedCount: 1 }));
    expect(encoded).toMatchObject({
      _tag: "Success",
      value: { importedCount: 2, skippedCount: 1 },
    });
  });
});
