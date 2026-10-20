import { DesktopRemoteRelayStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopRemoteRelay from "../../backend/DesktopRemoteRelay.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getRemoteRelayState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_REMOTE_RELAY_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopRemoteRelayStateSchema,
  handler: Effect.fn("desktop.ipc.remoteRelay.getState")(function* () {
    const remoteRelay = yield* DesktopRemoteRelay.DesktopRemoteRelay;
    return yield* remoteRelay.getState;
  }),
});

export const setRemoteRelayUrl = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_REMOTE_RELAY_URL_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: DesktopRemoteRelayStateSchema,
  handler: Effect.fn("desktop.ipc.remoteRelay.setUrl")(function* (url) {
    const remoteRelay = yield* DesktopRemoteRelay.DesktopRemoteRelay;
    return yield* remoteRelay.setUrl(url);
  }),
});
