import { assert, describe, it } from "@effect/vitest";

import { main, rustClientName } from "./build-terminal-archive.ts";

const args = (extra: ReadonlyArray<string>) => [
  "--platform",
  "linux",
  "--arch",
  "x64",
  "--version",
  "1.2.3",
  ...extra,
];

describe("build-terminal-archive", () => {
  it("names the Rust client for each platform", () => {
    assert.equal(rustClientName("mac"), "oop-rs");
    assert.equal(rustClientName("linux"), "oop-rs");
    assert.equal(rustClientName("win"), "oop-rs.exe");
  });

  it("refuses to build an archive without the Rust client: it is the only terminal", async () => {
    const failure = await main(args([])).then(
      () => null,
      (error: unknown) => error as Error,
    );
    assert.match(failure?.message ?? "", /--oop-rs/u);
  });

  it("refuses a Rust client path that does not exist", async () => {
    const failure = await main(args(["--oop-rs", "/nowhere/oop-rs"])).then(
      () => null,
      (error: unknown) => error as Error,
    );
    assert.match(failure?.message ?? "", /\/nowhere\/oop-rs/u);
  });
});
