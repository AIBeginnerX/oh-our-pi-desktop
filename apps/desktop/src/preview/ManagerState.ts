import type { PreviewAutomationActionEvent } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { playwrightInjectedRuntimeInstallExpression } from "./PlaywrightInjectedRuntime.ts";
import {
  type BrowserControlSession,
  type BrowserDiagnostics,
  DEFAULT_ANNOTATION_THEME,
  type ExpectedAgentInput,
  type FrameCaptureSession,
  type Listener,
  type ManagedListeners,
  type PickSession,
  type PictureInPictureSession,
  type PointerEventListener,
  type PreviewTabState,
  type RecordingFrameListener,
  type RecordingInputListener,
} from "./ManagerSupport.ts";

export const makePreviewNativeState = Effect.fnUntraced(function* (artifactDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const path = yield* Path.Path;
  const parentScope = yield* Scope.Scope;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const resolvedArtifactDirectory = path.resolve(artifactDirectory);
  const playwrightInstallExpression = yield* Effect.cached(
    playwrightInjectedRuntimeInstallExpression(),
  );

  const annotationThemeRef = yield* Ref.make(DEFAULT_ANNOTATION_THEME);
  const mainWindowRef = yield* Ref.make<Option.Option<BrowserWindow>>(Option.none());
  const tabsRef = yield* SynchronizedRef.make<ReadonlyMap<string, PreviewTabState>>(new Map());
  const attachedRef = yield* Ref.make<ReadonlyMap<number, ManagedListeners>>(new Map());
  const listenersRef = yield* Ref.make<ReadonlySet<Listener>>(new Set());
  const pointerEventListenersRef = yield* Ref.make<ReadonlySet<PointerEventListener>>(new Set());
  const recordingInputListenersRef = yield* Ref.make<ReadonlySet<RecordingInputListener>>(
    new Set(),
  );
  const recordingFrameListenersRef = yield* Ref.make<ReadonlySet<RecordingFrameListener>>(
    new Set(),
  );
  const pickSessionsRef = yield* Ref.make<ReadonlyMap<string, PickSession>>(new Map());
  const controlSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<number, BrowserControlSession>
  >(new Map());
  const diagnosticsRef = yield* Ref.make<ReadonlyMap<number, BrowserDiagnostics>>(new Map());
  const expectedAgentInputsRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<ExpectedAgentInput>>
  >(new Map());
  const controlEpochRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const actionTimelineRef = yield* Ref.make<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >(new Map());
  const actionSequenceRef = yield* Ref.make(0);
  const pointerSequenceRef = yield* Ref.make(0);
  const frameCaptureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, FrameCaptureSession>
  >(new Map());
  const pictureInPictureSessionsRef = yield* SynchronizedRef.make<
    ReadonlyMap<string, PictureInPictureSession>
  >(new Map());
  const pictureInPictureAspectRatiosRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const pictureInPictureMutationSemaphore = yield* Semaphore.make(1);
  const closingTabIdsRef = yield* Ref.make<ReadonlySet<string>>(new Set());

  const tabLifecycleLocks = new Map<
    string,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const tabLifecycleGenerations = new Map<string, number>();

  return {
    fileSystem,
    hostPlatform,
    path,
    parentScope,
    context,
    runFork,
    resolvedArtifactDirectory,
    playwrightInstallExpression,
    annotationThemeRef,
    mainWindowRef,
    tabsRef,
    attachedRef,
    listenersRef,
    pointerEventListenersRef,
    recordingInputListenersRef,
    recordingFrameListenersRef,
    pickSessionsRef,
    controlSessionsRef,
    diagnosticsRef,
    expectedAgentInputsRef,
    controlEpochRef,
    actionTimelineRef,
    actionSequenceRef,
    pointerSequenceRef,
    frameCaptureSessionsRef,
    pictureInPictureSessionsRef,
    pictureInPictureAspectRatiosRef,
    pictureInPictureMutationSemaphore,
    closingTabIdsRef,
    tabLifecycleLocks,
    tabLifecycleGenerations,
  };
});

export type PreviewNativeState = Effect.Success<ReturnType<typeof makePreviewNativeState>>;
