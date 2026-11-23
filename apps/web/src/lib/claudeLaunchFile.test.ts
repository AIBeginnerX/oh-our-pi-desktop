import { describe, expect, it } from "vite-plus/test";
import {
  claudeLaunchConfigurationToAction as convert,
  parseClaudeLaunchFile,
} from "./claudeLaunchFile";

describe("Claude launch file", () => {
  it("accepts comments, trailing commas and unknown fields without changing strings", () => {
    expect(
      parseClaudeLaunchFile(
        '{/* comment */ "version":"0.0.1", "configurations":[{"name":"web", "url":"http://localhost:3000//x",},],}',
      )?.configurations,
    ).toEqual([{ name: "web", url: "http://localhost:3000//x" }]);
  });
  it.each(["{", "{}", '{"configurations":false}'])("rejects invalid launch files: %s", (text) => {
    expect(parseClaudeLaunchFile(text)).toBeNull();
  });
  it("converts npm argv and keeps preview auto-open consistent with t3.json", () => {
    expect(
      convert({ name: "web", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 4321 })
        ?.action,
    ).toMatchObject({
      name: "web",
      command: "npm run dev",
      previewUrl: "http://localhost:4321",
      autoOpenPreview: false,
    });
  });
  it("runs program and args with node", () => {
    expect(convert({ name: "web", program: "server.js", args: ["--x"] })?.action.command).toBe(
      "node server.js --x",
    );
  });
  it("quotes whitespace, quotes, backslashes and shell expansions as literal argv", () => {
    expect(
      convert({
        name: "web",
        runtimeExecutable: "npm",
        runtimeArgs: ["a b", 'a"b', "a\\b", "$(x)", ""],
      })?.action.command,
    ).toBe('npm "a b" "a\\"b" "a\\\\b" "\\$(x)" ""');
  });
  it("defaults the port to 3000", () => {
    expect(convert({ name: "web", program: "server.js" })?.action.previewUrl).toBe(
      "http://localhost:3000",
    );
  });
  it("prefers url to port", () => {
    expect(
      convert({ name: "web", program: "server.js", port: 42, url: "http://localhost:42/app" })
        ?.action.previewUrl,
    ).toBe("http://localhost:42/app");
  });
  it("makes workspaceFolder cwd relative and quotes it", () => {
    expect(
      convert({ name: "web", program: "server.js", cwd: "${workspaceFolder}/apps/my web" })?.action
        .command,
    ).toBe('cd "apps/my web" && node server.js');
    expect(
      convert({ name: "web", program: "server.js", cwd: "${workspaceFolder}" })?.action.command,
    ).toBe("node server.js");
  });
  it("skips configurations without an executable or program", () => {
    expect(convert({ name: "web" })).toBeNull();
  });
  it("reports ignored environment variables", () => {
    expect(
      convert({ name: "web", program: "server.js", env: { K: "v" }, autoPort: true })
        ?.skippedEnvironmentVariables,
    ).toBe(true);
  });
});
