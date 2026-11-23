import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const ThreadPullRequestAutoFix = Schema.Struct({
  enabled: Schema.Boolean,
  setAt: IsoDateTime,
});
export type ThreadPullRequestAutoFix = typeof ThreadPullRequestAutoFix.Type;

export const ThreadPullRequestAutoFixSettings = Schema.Record(ThreadId, ThreadPullRequestAutoFix);
