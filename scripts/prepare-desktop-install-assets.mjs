#!/usr/bin/env node
// Prepares local files only. Never uploads, publishes, or builds from private binaries.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    mac: { type: "string" },
    windows: { type: "string" },
    linux: { type: "string" },
    out: { type: "string" },
  },
});
if (
  !values.version ||
  !/^\d+\.\d+\.\d+$/.test(values.version) ||
  !values.mac ||
  !values.windows ||
  !values.linux ||
  !values.out
) {
  throw new Error(
    "Usage: node scripts/prepare-desktop-install-assets.mjs --version X.Y.Z --mac PATH.dmg --windows PATH.exe --linux PATH.AppImage --out DIRECTORY",
  );
}
const assets = [
  [values.mac, `OOP-${values.version}-arm64.dmg`],
  [values.windows, `OOP-${values.version}-x64.exe`],
  [values.linux, `OOP-${values.version}-x86_64.AppImage`],
];
// Reject a missing, misnamed, or empty platform file before creating any output.
for (const [source, name] of assets) {
  const stat = await fs.stat(source);
  if (path.basename(source) !== name || !stat.isFile() || stat.size === 0) {
    throw new Error(`Expected a nonempty release file named ${name}`);
  }
}
await fs.mkdir(values.out, { recursive: true });
for (const [source, name] of assets) {
  const destination = path.join(values.out, name);
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  const hash = createHash("sha256");
  const file = await fs.open(destination);
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close();
  }
  const digest = hash.digest("hex");
  await fs.writeFile(path.join(values.out, `${name}.sha256`), `${digest}  ${name}\n`, {
    flag: "wx",
  });
}
console.log(
  `Prepared ${assets.length} installers and their SHA-256 files in ${path.resolve(values.out)}. Nothing was published.`,
);
