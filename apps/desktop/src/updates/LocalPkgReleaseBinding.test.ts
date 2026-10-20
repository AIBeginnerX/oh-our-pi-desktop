import { describe, expect, it } from "vite-plus/test";

import {
  RELEASE_BUNDLE_ID,
  RELEASE_PACKAGE_ID,
  RELEASE_PRODUCT_ID,
  hasReleaseBinding,
  releaseProductElement,
  signedExtractedSha1s,
} from "./LocalPkgReleaseBinding.ts";

describe("LocalPkgReleaseBinding", () => {
  it("freezes the package and bundle identity used by the release builder", () => {
    expect(RELEASE_PRODUCT_ID).toBe("oop-desktop");
    expect(RELEASE_PACKAGE_ID).toBe("local.oop.desktop.installer");
    expect(RELEASE_BUNDLE_ID).toBe("com.t3tools.t3code");
  });

  it("binds one exact product id and version element", () => {
    const element = releaseProductElement("0.0.59");
    expect(element).toBe('<product id="oop-desktop" version="0.0.59"/>');
    expect(hasReleaseBinding(`<installer>${element}</installer>`, "0.0.59")).toBe(true);
    expect(hasReleaseBinding(`<installer>${element}</installer>`, "0.0.58")).toBe(false);
  });

  it("requires exactly one product start and the exact release element", () => {
    const element = releaseProductElement("0.0.59");
    for (const distribution of [
      "<installer/>",
      `<installer>${element}${element}</installer>`,
      `<installer><product id="other" version="0.0.59"/></installer>`,
      `<installer><product version="0.0.59" id="oop-desktop"/></installer>`,
      `<installer><product id="oop-desktop" version="0.0.59" /></installer>`,
      `<installer>${element}<product id="extra"/></installer>`,
    ]) {
      expect(hasReleaseBinding(distribution, "0.0.59")).toBe(false);
    }
  });

  it("only accepts exact lowercase extracted SHA-1 entries from the TOC", () => {
    const first = "0123456789abcdef0123456789abcdef01234567";
    const second = "89abcdef0123456789abcdef0123456789abcdef";
    const toc =
      `<extracted-checksum style="sha1">${first}</extracted-checksum>` +
      `<extracted-checksum style="sha1">${second}</extracted-checksum>` +
      `<extracted-checksum style="sha256">${"a".repeat(64)}</extracted-checksum>` +
      `<archived-checksum style="sha1">${"b".repeat(40)}</archived-checksum>` +
      `<extracted-checksum style="sha1">${"A".repeat(40)}</extracted-checksum>` +
      `<extracted-checksum style="sha1"> ${first}</extracted-checksum>` +
      `<extracted-checksum style="sha1" extra="x">${first}</extracted-checksum>`;
    expect(signedExtractedSha1s(toc)).toEqual(new Set([first, second]));
    expect(signedExtractedSha1s("")).toEqual(new Set());
  });

  it("rejects invalid release versions without allowing markup into the element", () => {
    for (const version of ["0.0.59-preview.1", "0.0.59<product", "latest"]) {
      expect(() => releaseProductElement(version)).toThrow("Invalid release version.");
      expect(hasReleaseBinding("<installer/>", version)).toBe(false);
    }
  });
});
