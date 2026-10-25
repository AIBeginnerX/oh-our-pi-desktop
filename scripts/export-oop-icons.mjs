#!/usr/bin/env node
// Rebuild the committed OOP macOS icon and web favicon assets from one SVG.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const assetDir = NodePath.join(repoRoot, "assets", "oop");
const source = NodePath.join(assetDir, "oop-icon.svg");
const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "oop-icon-export-"));

function sips(args) {
  const result = NodeChildProcess.spawnSync("sips", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`sips ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

try {
  const macIcon = NodePath.join(assetDir, "oop-macos-1024.png");
  sips(["-s", "format", "png", source, "--out", macIcon]);
  const cropped = NodePath.join(temporaryDirectory, "cropped.png");
  sips(["-c", "824", "824", macIcon, "--out", cropped]);

  const images = [];
  for (const size of [16, 32, 48, 64, 128, 180, 256]) {
    const output = NodePath.join(assetDir, `oop-web-${size}.png`);
    sips(["-z", String(size), String(size), cropped, "--out", output]);
    if (size !== 180) images.push({ size, data: NodeFS.readFileSync(output) });
  }
  const favicon = NodePath.join(assetDir, "oop-web-favicon.ico");
  NodeFS.writeFileSync(favicon, encodeIco(images));
  NodeFS.copyFileSync(favicon, NodePath.join(assetDir, "oop-windows.ico"));
  const publicDir = NodePath.join(repoRoot, "apps", "web", "public");
  for (const [sourceName, targetName] of [
    ["oop-web-16.png", "favicon-16x16.png"],
    ["oop-web-32.png", "favicon-32x32.png"],
    ["oop-web-180.png", "apple-touch-icon.png"],
    ["oop-web-favicon.ico", "favicon.ico"],
  ]) {
    NodeFS.copyFileSync(NodePath.join(assetDir, sourceName), NodePath.join(publicDir, targetName));
  }
} finally {
  NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
}
