/**
 * The release identity the OOP update builder writes into a package's
 * `Distribution` and the runtime looks for in it. No imports on purpose:
 * `scripts/build-oop-update-pkg.mjs` loads this file directly under Node's type
 * stripping, so keep it to erasable TypeScript.
 *
 * The `Distribution` text is publisher-authored and signed, and the runtime only
 * reads it after the publisher check passed, so a substring match is enough and
 * no XML parser is involved. A second `<product` occurrence is rejected. This
 * ties a signed package to one OOP release; it does not prove what the app
 * payload contains.
 */

export const RELEASE_PRODUCT_ID = "oop-desktop";
export const RELEASE_PACKAGE_ID = "local.oop.desktop.installer";
export const RELEASE_BUNDLE_ID = "com.t3tools.t3code";

/** Broader than the runtime's stable versions on purpose: rollback builds may use any numeric triple. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/u;

/** Throws for a version that is not a numeric triple, so a version can never put markup into the element. */
export const releaseProductElement = (version: string): string => {
  if (!RELEASE_VERSION.test(version)) throw new Error("Invalid release version.");
  return `<product id="${RELEASE_PRODUCT_ID}" version="${version}"/>`;
};

/** Never throws: a version that is not a numeric triple has no binding. */
export const hasReleaseBinding = (distribution: string, version: string): boolean =>
  RELEASE_VERSION.test(version) &&
  distribution.split("<product").length === 2 &&
  distribution.includes(releaseProductElement(version));

// Exact xar serialization only. Anything else matches nothing, so the check fails closed.
// Accepted algorithms: sha1 only. md5 is never accepted.
const SIGNED_SHA1 = /<extracted-checksum style="sha1">([0-9a-f]{40})<\/extracted-checksum>/g;

/**
 * The SHA-1 `extracted-checksum` values of a package's table of contents. The
 * caller has already had the OS verify the TOC's signature and the package is
 * one of our publisher's own release inputs, so every value was written by us
 * for that release. Finding the SHA-1 of the bytes tar printed for
 * `Distribution` among them shows those bytes are content we signed. That
 * authenticates signed content only: it does not say which archive member holds
 * it, and says nothing about the app payload. It also relies on the publisher
 * emitting a `<product` element in `Distribution` alone (the current one does,
 * and a test checks the welcome page has none); a future publisher or OS tool
 * that changes that, or the checksum style, needs its own checks. An algorithm
 * other than SHA-1 is not accepted until it has real-tool evidence.
 */
export const signedExtractedSha1s = (toc: string): ReadonlySet<string> =>
  new Set(Array.from(toc.matchAll(SIGNED_SHA1), (match) => match[1] ?? ""));
