// node:sqlite reads the live ZCode and MiniMax Code databases read-only.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { isReportedTokenCount, totalTokens, type UsageRecord } from "./usageTranscripts.ts";

type Row = Record<string, unknown>;

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * One ZCode `model_usage` row. ZCode reports input the OpenAI way, with cached tokens inside
 * `input_tokens`, so the uncached part is what remains after the cache reads and writes.
 */
export function parseZCodeUsageRow(row: Row): UsageRecord | null {
  const model = text(row.model_id).trim();
  const timestampMs =
    typeof row.completed_at === "number" ? row.completed_at : (row.started_at as number);
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const cacheRead = tokens(row.cache_read_input_tokens);
  const cacheWrite = tokens(row.cache_creation_input_tokens);
  const reasoningTokens = tokens(row.reasoning_tokens);
  const totals = {
    uncachedInputTokens: Math.max(0, tokens(row.input_tokens) - cacheRead - cacheWrite),
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens: tokens(row.output_tokens),
    reasoningTokens: Math.min(reasoningTokens, tokens(row.output_tokens)),
  };
  if (totalTokens(totals) === 0) return null;
  const id = text(row.id);
  return {
    provider: "zcode",
    timestampMs,
    model,
    sessionId: text(row.session_id),
    totals,
    // Coding Plan accounts report no price; the shared rate table estimates one.
    reportedCostUsd: null,
    cacheReport: {
      read: isReportedTokenCount(row.cache_read_input_tokens),
      write: isReportedTokenCount(row.cache_creation_input_tokens),
    },
    fast: false,
    dedupeKey: id ? `zcode:${id}` : null,
  };
}

/**
 * One MiniMax Code `token_usage` row. MiniMax reports input the Anthropic way, with cache reads
 * and writes beside it, and records its own cost.
 */
export function parseMiniMaxUsageRow(row: Row): UsageRecord | null {
  const model = text(row.model)
    .trim()
    .replace(/^minimax\//i, "");
  const timestampMs = row.ts;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(row.reasoning_tokens);
  const totals = {
    uncachedInputTokens: tokens(row.input_tokens),
    cachedInputTokens: tokens(row.cache_read_tokens),
    cacheCreationTokens: tokens(row.cache_write_tokens),
    outputTokens: tokens(row.output_tokens) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const cost = row.cost_usd;
  const sessionId = text(row.session_id);
  return {
    provider: "minimax",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    cacheReport: {
      read: isReportedTokenCount(row.cache_read_tokens),
      write: isReportedTokenCount(row.cache_write_tokens),
    },
    fast: false,
    // The legacy and v2 stores can hold the same call under different row ids.
    dedupeKey: `minimax:${sessionId}:${timestampMs}:${model}:${totalTokens(totals)}`,
  };
}

export interface HarnessDbUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

interface HarnessDbSource {
  readonly path: string;
  readonly table: string;
  readonly timeColumn: string;
  readonly parse: (row: Row) => UsageRecord | null;
}

async function readHarnessDatabases(
  sources: readonly HarnessDbSource[],
  sinceMs: number,
): Promise<HarnessDbUsageReadResult> {
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
  for (const source of sources) {
    try {
      await NodeFSP.access(source.path);
    } catch {
      continue;
    }
    found = true;
    const file = { path: source.path, records: [] as UsageRecord[] };
    files.push(file);
    let database: NodeSqlite.DatabaseSync | undefined;
    try {
      database = new NodeSqlite.DatabaseSync(source.path, { readOnly: true });
      // A busy live harness should fail this source promptly rather than stall the server.
      database.exec("PRAGMA busy_timeout = 100");
      const hasTable = database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(source.table);
      if (hasTable === undefined) continue;
      const statement = database.prepare(
        `SELECT * FROM ${source.table} WHERE ${source.timeColumn} >= ?`,
      );
      let count = 0;
      for (const row of statement.iterate(sinceMs)) {
        const record = source.parse(row as Row);
        if (record !== null && record.timestampMs >= sinceMs) {
          if (record.dedupeKey === null || !seen.has(record.dedupeKey)) {
            if (record.dedupeKey !== null) seen.add(record.dedupeKey);
            file.records.push(record);
          }
        }
        if (++count % 256 === 0) await NodeTimersPromises.setImmediate();
      }
    } catch {
      error = true;
    } finally {
      database?.close();
    }
  }
  return { files, missing: !found && !error, error };
}

/** ZCode keeps every model call of its CLI, app-server, and desktop app in one database. */
export function readZCodeUsage(databasePath: string, sinceMs: number) {
  return readHarnessDatabases(
    [
      {
        path: databasePath,
        table: "model_usage",
        timeColumn: "started_at",
        parse: parseZCodeUsageRow,
      },
    ],
    sinceMs,
  );
}

/** MiniMax Code moved token usage to its v2 runtime store; older calls stay in the legacy one. */
export function readMiniMaxUsage(
  databasePaths: { legacy: string; runtime: string },
  sinceMs: number,
) {
  return readHarnessDatabases(
    [
      {
        path: databasePaths.runtime,
        table: "local_runtime_token_usage",
        timeColumn: "ts",
        parse: parseMiniMaxUsageRow,
      },
      {
        path: databasePaths.legacy,
        table: "token_usage",
        timeColumn: "ts",
        parse: parseMiniMaxUsageRow,
      },
    ],
    sinceMs,
  );
}
