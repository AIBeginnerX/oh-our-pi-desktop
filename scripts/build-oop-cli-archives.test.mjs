import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { oopRsDockerArgs, parseArgs, TARGETS } from "./build-oop-cli-archives.mjs";

NodeTest.test("--terminal also builds the terminal-only archives, and nothing else changes", () => {
  NodeAssert.deepEqual(parseArgs([]), {
    version: undefined,
    skipBundle: false,
    skipSmoke: false,
    terminal: false,
  });
  NodeAssert.equal(parseArgs(["--terminal", "--version", "1.2.3"]).terminal, true);
  NodeAssert.equal(parseArgs(["--terminal", "--version", "1.2.3"]).version, "1.2.3");
  NodeAssert.throws(() => parseArgs(["--terminals"]), /Unknown option/);
});

NodeTest.test(
  "oop-rs for Linux is built in a Debian 12 container for the target CPU with the release version",
  () => {
    const linux = TARGETS.filter((target) => target.docker !== null);
    NodeAssert.deepEqual(
      linux.map((target) => target.docker),
      ["linux/amd64", "linux/arm64"],
    );
    const args = oopRsDockerArgs(linux[1], {
      source: "/Users/test/src",
      cargoTarget: "/Users/test/.cache/target",
      registry: "/Users/test/.cache/registry",
      version: "1.2.3",
    });
    NodeAssert.equal(args[args.indexOf("--platform") + 1], "linux/arm64");
    // The source is read-only; only the build output and the registry cache are writable.
    NodeAssert.ok(args.includes("/Users/test/src:/src:ro"));
    NodeAssert.ok(args.includes("OOP_VERSION=1.2.3"));
    NodeAssert.ok(args.includes("CARGO_TARGET_DIR=/target"));
    NodeAssert.deepEqual(args.slice(args.indexOf("rust:1-bookworm")), [
      "rust:1-bookworm",
      "cargo",
      "build",
      "--release",
      "--locked",
    ]);
    NodeAssert.equal(args[args.indexOf("-w") + 1], "/src/apps/oop-tui-rs");
  },
);
