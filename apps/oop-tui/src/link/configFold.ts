// `applyServerConfigProjection` is not exposed by a package subpath, and packages may not change
// from here. This is the one place that reaches it by path; when client-runtime exports it, only
// this import moves.
export {
  applyServerConfigProjection,
  type ServerConfigProjection,
} from "../../../../packages/client-runtime/src/state/serverConfigProjection.ts";
