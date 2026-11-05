// @effect-diagnostics nodeBuiltinImport:off - Runs the generated askpass script itself.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  buildSshAskpassHelperDescriptor,
  buildSshChildEnvironment,
  isSshAuthFailure,
  isSshHostKeyFailure,
  parseSshHostKeyProbe,
} from "./auth.ts";

describe("ssh auth", () => {
  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );

  it.effect("creates askpass env for cached password prompts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const env = yield* buildSshChildEnvironment({
        authSecret: "super-secret",
        interactiveAuth: true,
        askpassDirectory: directory,
        baseEnv: {},
      });

      const askpassPath = path.join(directory, "ssh-askpass.sh");
      assert.equal(env.SSH_ASKPASS, askpassPath);
      assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
      assert.equal(env.T3_SSH_AUTH_SECRET, "super-secret");
      assert.equal(env.DISPLAY, "t3code");
      assert.equal(yield* fs.exists(askpassPath), true);
      assert.include(yield* fs.readFileString(askpassPath), 'printf "%s\\n" "$T3_SSH_AUTH_SECRET"');
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcessPlatform, "linux"))),
      Effect.scoped,
    ),
  );

  it.effect("classifies unknown host keys apart from changed ones", () =>
    Effect.sync(() => {
      const unknown = [
        "debug1: Server host key: ssh-ed25519 SHA256:abc/DEF+123",
        "No ED25519 host key is known for devbox and you have requested strict checking.",
        "Host key verification failed.",
      ].join("\n");
      assert.equal(isSshHostKeyFailure(new Error(unknown)), true);
      assert.deepEqual(parseSshHostKeyProbe(unknown), {
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:abc/DEF+123",
      });

      const changed = [
        "debug1: Server host key: ssh-ed25519 SHA256:abc",
        "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
        "Offending ED25519 key in /home/u/.ssh/known_hosts:3",
        "Host key verification failed.",
      ].join("\n");
      assert.equal(isSshHostKeyFailure(new Error(changed)), false);
      assert.equal(parseSshHostKeyProbe(changed), null);
      assert.equal(parseSshHostKeyProbe("Connection timed out"), null);
      assert.equal(parseSshHostKeyProbe("Host key verification failed."), null);
    }),
  );

  it.effect("askpass answers host key questions and still returns the password otherwise", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-askpass-test-" });
      const run = (prompt: string, env: Record<string, string>) =>
        NodeChildProcess.spawnSync(`${directory}/ssh-askpass.sh`, [prompt], {
          env: { PATH: process.env.PATH ?? "", ...env },
          encoding: "utf8",
        }).stdout;
      yield* buildSshChildEnvironment({
        interactiveAuth: true,
        askpassDirectory: directory,
        baseEnv: {},
      });
      const question =
        "The authenticity of host 'h' can't be established.\nED25519 key fingerprint is SHA256:x.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

      assert.equal(run(question, {}), "no\n");
      assert.equal(
        run(question, { T3_SSH_HOSTKEY_ANSWER: "SHA256:x", T3_SSH_AUTH_SECRET: "pw" }),
        "SHA256:x\n",
      );
      assert.equal(run("The authenticity of host 'h'.", { SSH_ASKPASS_PROMPT: "confirm" }), "no\n");
      // Windows hands over only the prompt's first line; the answer must not depend on it.
      assert.equal(
        run("The authenticity of host 'h' can't be established.", {
          T3_SSH_HOSTKEY_ANSWER: "SHA256:x",
        }),
        "SHA256:x\n",
      );
      assert.equal(
        run("Please type 'yes', 'no' or the fingerprint: ", { T3_SSH_HOSTKEY_ANSWER: "SHA256:x" }),
        "no\n",
      );
      assert.equal(run("kcc@host's password: ", { T3_SSH_AUTH_SECRET: "pw" }), "pw\n");
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, Layer.succeed(HostProcessPlatform, "linux"))),
      Effect.scoped,
    ),
  );

  it.effect("builds a windows askpass launcher pair", () =>
    Effect.gen(function* () {
      const descriptor = yield* buildSshAskpassHelperDescriptor({
        directory: "C:\\temp\\t3code-ssh-askpass",
      }).pipe(
        Effect.provide(
          Layer.merge(NodeServices.layer, Layer.succeed(HostProcessPlatform, "win32")),
        ),
      );

      assert.equal(descriptor.launcherPath, "C:\\temp\\t3code-ssh-askpass\\ssh-askpass.cmd");
      assert.deepEqual(
        descriptor.files.map((file) => file.path.split("\\").at(-1)),
        ["ssh-askpass.cmd", "ssh-askpass.ps1"],
      );
    }),
  );
});
