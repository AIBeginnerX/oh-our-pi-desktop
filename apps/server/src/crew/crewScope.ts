/**
 * Repo-relative path patterns as the lead writes them (a file, a directory, or a directory with a
 * trailing glob), shared by write-scope overlap warnings and the TODO checks.
 */

/** A path as its directory segments, without "./" or trailing globs; none means the whole repo. */
export function scopeSegments(path: string): ReadonlyArray<string> {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  const glob = segments.findIndex((segment) => segment.includes("*"));
  return glob === -1 ? segments : segments.slice(0, glob);
}

/** Whether `file` is one of the patterns, or lies inside a directory one of them names. */
export function pathInScope(file: string, patterns: ReadonlyArray<string>): boolean {
  const target = file.split("/").filter((segment) => segment !== "" && segment !== ".");
  return patterns.some((pattern) => {
    const prefix = scopeSegments(pattern);
    return (
      prefix.length <= target.length && prefix.every((segment, index) => segment === target[index])
    );
  });
}
