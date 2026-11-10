/**
 * Paths a crew_delegate brief cites (in `task`, `verify`, and todo `check.files`), checked against
 * the directory the member will work in, so the lead hears about a missing file (a gitignored
 * reference, a path written from the wrong cwd) at delegation time instead of from a blocked
 * member later. The warning never blocks the delegation and only ever reads with a stat.
 * @module missingPaths
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { pathInScope } from "../../../crew/crewScope.ts";
import { expandHomePathWith } from "../../../pathExpansion.ts";

const MAX_PATHS = 30;
const MAX_TOKEN_LENGTH = 300;
const WARNING_PATHS = 5;
const trailingJunk = /[`,.;:!?)\]}'"]+$/;
const leadingJunk = /^[`'"([]+/;
const url = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Path-like tokens in free text: absolute, `~/` or `./` prefixed, or containing `/` with a file
 * extension or a trailing `/`. URLs and globs are skipped; quoting and trailing punctuation are
 * stripped (a markdown link keeps only its target); duplicates are dropped, capped at 30.
 */
export function extractPathTokens(text: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const raw of text.split(/\s+/)) {
    let token = raw.replace(trailingJunk, "");
    const linkTarget = token.indexOf("](");
    if (linkTarget !== -1) token = token.slice(linkTarget + 2);
    token = token.replace(leadingJunk, "");
    const pathLike =
      /^(\/|~\/|\.\.?\/)/.test(token) ||
      (token.includes("/") && (/\.[A-Za-z0-9]+$/.test(token) || token.endsWith("/")));
    if (
      token.length === 0 ||
      token.length > MAX_TOKEN_LENGTH ||
      token.includes("*") ||
      url.test(token) ||
      !pathLike ||
      tokens.includes(token)
    ) {
      continue;
    }
    tokens.push(token);
    if (tokens.length === MAX_PATHS) break;
  }
  return tokens;
}

export interface CitedPaths {
  readonly task: string;
  readonly verify?: string | undefined;
  readonly todos?:
    | ReadonlyArray<
        | string
        | { readonly check?: { readonly files?: ReadonlyArray<string> | undefined } | undefined }
      >
    | undefined;
  readonly writeScope?: ReadonlyArray<string> | undefined;
}

const collectCandidates = (input: CitedPaths): ReadonlyArray<string> => {
  const files = (input.todos ?? []).flatMap((todo) =>
    typeof todo === "string" ? [] : (todo.check?.files ?? []),
  );
  const text = [input.task, input.verify].filter((part) => part !== undefined).join("\n");
  return [...new Set([...files, ...extractPathTokens(text)])].slice(0, MAX_PATHS);
};

const resolveFrom = (path: Path.Path, cwd: string, candidate: string): string =>
  path.resolve(cwd, expandHomePathWith(candidate, path));

/** WriteScope names what the member may create, so a missing path it covers is not a mistake. */
const expectedToBeCreated = (
  path: Path.Path,
  cwd: string,
  candidate: string,
  writeScope: ReadonlyArray<string>,
): boolean => {
  const relative = path.relative(cwd, resolveFrom(path, cwd, candidate));
  return (
    !relative.startsWith("..") && !path.isAbsolute(relative) && pathInScope(relative, writeScope)
  );
};

/** One warning naming at most 5 missing paths. Undefined when none are missing; never fails. */
export const missingPathsWarning = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  input: CitedPaths,
): Effect.fn.Return<string | undefined, never, never> {
  const missing: string[] = [];
  for (const candidate of collectCandidates(input)) {
    if (expectedToBeCreated(path, cwd, candidate, input.writeScope ?? [])) continue;
    const stat = yield* Effect.result(fs.stat(resolveFrom(path, cwd, candidate)));
    if (Result.isFailure(stat) && stat.failure.reason._tag === "NotFound") {
      missing.push(candidate);
    }
  }
  if (missing.length === 0) return undefined;
  const named = missing.slice(0, WARNING_PATHS).join(", ");
  const more = missing.length > WARNING_PATHS ? ` (+${missing.length - WARNING_PATHS} more)` : "";
  return `These paths do not exist from ${cwd}: ${named}${more}. Fix the brief or the check, or ignore if the member creates them.`;
});
