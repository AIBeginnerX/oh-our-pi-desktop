/**
 * OpenCode 2 changed its HTTP protocol: the API moved under `/api`, the server
 * always requires HTTP Basic auth, and sessions report work through one event
 * stream. The 1.x SDK cannot talk to it, so 2.x uses its own client.
 *
 * @module provider/opencode2/OpenCode2Client
 */
import { OpenCode, isServiceUnavailableError } from "@opencode/client/promise";
import { parseSemver } from "@t3tools/shared/semver";

export type OpenCode2Client = ReturnType<typeof OpenCode.make>;

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

export function isOpenCode2Version(version: string | null | undefined): boolean {
  const major = parseSemver(version?.replace(/^v/, "") ?? "")?.major;
  return major !== undefined && major >= 2;
}

/** OpenCode decodes Basic credentials as UTF-8. */
export function openCode2Authorization(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${password}`, "utf8").toString("base64")}`;
}

export function makeOpenCode2Client(input: {
  readonly baseUrl: string;
  readonly password: string;
}): OpenCode2Client {
  return OpenCode.make({
    baseUrl: input.baseUrl,
    headers: { Authorization: openCode2Authorization(input.password) },
  });
}

/** A fresh password for a server OOP owns; OpenCode 2 prints its own otherwise. */
export function generateOpenCode2Password(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * A new location answers `ServiceUnavailable` until its plugins finish
 * activating, which takes a few seconds on a cold start.
 */
export async function retryWhileActivating<A>(
  run: () => Promise<A>,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<A> {
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (cause) {
      if (attempt >= attempts || !isServiceUnavailableError(cause)) throw cause;
      // @effect-diagnostics-next-line globalTimers:off - a plain Promise helper for the SDK client, outside Effect.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
