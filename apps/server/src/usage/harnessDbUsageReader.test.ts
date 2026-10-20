// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import {
  parseMiniMaxUsageRow,
  parseZCodeUsageRow,
  readMiniMaxUsage,
  readZCodeUsage,
} from "./harnessDbUsageReader.ts";

describe("ZCode usage", () => {
  it("splits cached tokens out of ZCode's input total", () => {
    const record = parseZCodeUsageRow({
      id: "usage_1",
      session_id: "sess_1",
      model_id: "GLM-5.3-Flash",
      started_at: 1_000,
      completed_at: 2_000,
      input_tokens: 423_825,
      output_tokens: 905,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 422_528,
    });
    expect(record).toMatchObject({
      provider: "zcode",
      model: "GLM-5.3-Flash",
      timestampMs: 2_000,
      reportedCostUsd: null,
      dedupeKey: "zcode:usage_1",
      totals: { uncachedInputTokens: 1_297, cachedInputTokens: 422_528, outputTokens: 905 },
    });
  });
});

describe("MiniMax Code usage", () => {
  const row = {
    session_id: "mvs_1",
    model: "minimax/MiniMax-M3",
    ts: 5_000,
    input_tokens: 43,
    output_tokens: 162,
    reasoning_tokens: 0,
    cache_read_tokens: 61_489,
    cache_write_tokens: 0,
    cost_usd: 0.00779328,
  };

  it("keeps MiniMax's separate cache counts and its own cost", () => {
    expect(parseMiniMaxUsageRow(row)).toMatchObject({
      provider: "minimax",
      model: "MiniMax-M3",
      reportedCostUsd: 0.00779328,
      totals: { uncachedInputTokens: 43, cachedInputTokens: 61_489, outputTokens: 162 },
    });
  });

  it("reads both stores once, skipping a call copied into the v2 store", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-minimax-usage-"));
    try {
      const create = (path: string, table: string) => {
        const database = new NodeSqlite.DatabaseSync(path);
        database.exec(
          `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL)`,
        );
        const insert = database.prepare(
          `INSERT INTO ${table} (session_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        return { database, insert };
      };
      const legacy = create(NodePath.join(dir, "sqlite.db"), "token_usage");
      legacy.insert.run("mvs_1", "minimax/MiniMax-M3", 5_000, 43, 162, 0, 61_489, 0, 0.01);
      legacy.insert.run("mvs_0", "minimax/MiniMax-M3", 10, 1, 1, 0, 0, 0, 0);
      legacy.database.close();
      await NodeFSP.mkdir(NodePath.join(dir, "v2"));
      const runtime = create(
        NodePath.join(dir, "v2", "runtime.sqlite"),
        "local_runtime_token_usage",
      );
      runtime.insert.run("mvs_1", "minimax/MiniMax-M3", 5_000, 43, 162, 0, 61_489, 0, 0.01);
      runtime.insert.run("mvs_2", "MiniMax-M3", 6_000, 10, 20, 0, 0, 0, 0.001);
      runtime.database.close();

      const result = await readMiniMaxUsage(
        {
          legacy: NodePath.join(dir, "sqlite.db"),
          runtime: NodePath.join(dir, "v2", "runtime.sqlite"),
        },
        1_000,
      );
      expect(result.error).toBe(false);
      expect(
        result.files.flatMap((file) => file.records).map((record) => record.sessionId),
      ).toEqual(["mvs_1", "mvs_2"]);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing store as missing, not as an error", async () => {
    const result = await readZCodeUsage(
      NodePath.join(NodeOS.tmpdir(), "no-such-zcode", "db.sqlite"),
      0,
    );
    expect(result).toEqual({ files: [], missing: true, error: false });
  });
});
