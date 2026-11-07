import {
  DesktopPhoneSharedEnvironmentSchema,
  DesktopSetPhoneSharedInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopGatewayPublisher from "../../gateway/DesktopGatewayPublisher.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getPhoneSharedEnvironments = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_PHONE_SHARED_ENVIRONMENTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopPhoneSharedEnvironmentSchema),
  handler: Effect.fn("desktop.ipc.phoneSharing.get")(function* () {
    const publisher = yield* DesktopGatewayPublisher.DesktopGatewayPublisher;
    return yield* publisher.status;
  }),
});

export const setEnvironmentPhoneShared = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_ENVIRONMENT_PHONE_SHARED_CHANNEL,
  payload: DesktopSetPhoneSharedInputSchema,
  result: Schema.Array(DesktopPhoneSharedEnvironmentSchema),
  handler: Effect.fn("desktop.ipc.phoneSharing.set")(function* ({ environmentId, shared }) {
    const publisher = yield* DesktopGatewayPublisher.DesktopGatewayPublisher;
    return yield* publisher.setShared(environmentId, shared);
  }),
});
