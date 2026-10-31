import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  desktopAppVersion: Schema.optionalKey(TrimmedNonEmptyString),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  otlpLogsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  // Set by the desktop for the server it starts on the host, so a second
  // server on the same state directory exits with code 75 instead of
  // orphaning the first one's turns.
  instanceLock: Schema.optionalKey(Schema.Boolean),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;

/** Written to `<t3Home>/runtime` just before the desktop app stops its
    backend to install an update. The updated app starts a new backend right
    away, so a backend that sees a fresh marker at shutdown keeps its managed
    tunnel. */
export const DESKTOP_UPDATE_RESTART_MARKER_FILE = "desktop-update-restart";

/** Written to `<t3Home>/runtime` before the desktop app quits on any update
    install path (feed, DMG replace, setup launch). Unlike the restart marker
    it is never read by the backend; other local processes use its age to
    avoid starting a server while the installer replaces the app. The app
    removes it when the install fails to start and again at its next start. */
export const DESKTOP_UPDATE_INSTALLING_MARKER_FILE = "desktop-update-installing";
