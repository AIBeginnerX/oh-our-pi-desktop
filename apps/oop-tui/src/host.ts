import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

/** The platform this client runs on, read through the shared reference like the rest of the repo. */
export const hostPlatform = (): NodeJS.Platform => Effect.runSync(HostProcessPlatform);
