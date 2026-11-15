import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import { parseClaudeLine, type UsageRecord } from "./usageTranscripts.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    cacheReport: { read: true, write: true },
    fast: false,
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

/** A record as stored by a cache written before coverage reporting. */
function legacyRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  const result = { ...record(overrides) };
  delete result.cacheReport;
  return result;
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    codexState: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores records unchanged", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [
          record({ cacheWriteOneHourTokens: 3 }),
          record({
            dedupeKey: "msg_2:",
            model: "claude-opus-5-5",
            fast: true,
            cacheWriteOneHourTokens: 4,
          }),
        ],
      ],
      [
        "/b.jsonl",
        200,
        [record({ sessionId: "session-b", reportedCostUsd: 1.5, cacheWriteOneHourTokens: 2 })],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
      ],
      tailRecords: [record({ provider: "grok", model: "grok-4.5-build", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    original.set("/codex.jsonl", {
      size: 80,
      mtimeMs: 400,
      provider: "codex",
      records: [record({ provider: "codex", model: "gpt-5.2-codex", dedupeKey: null })],
      tailRecords: [],
      position: position({
        codexState: {
          model: "gpt-5.2-codex",
          sessionId: "session-c",
          lastUsageSignature: '{"input_tokens":1}',
          sawSessionMeta: true,
          suppressingForkCopies: false,
          forkCopyAnchorMs: 0,
        },
      }),
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

    expect(restored.size).toBe(4);
    expect(restored.get("/a.jsonl")).toEqual(original.get("/a.jsonl"));
    expect(restored.get("/b.jsonl")).toEqual(original.get("/b.jsonl"));
    expect(restored.get("/grok.jsonl")).toEqual(original.get("/grok.jsonl"));
    expect(restored.get("/codex.jsonl")).toEqual(original.get("/codex.jsonl"));
  });

  it("round-trips the coverage bitmask in both bits", () => {
    for (const [read, write] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      // No cache writes: the row is 12-slot and unambiguous either way.
      const original = cacheWith([
        [
          "/a.jsonl",
          100,
          [
            record({
              cacheReport: { read, write },
              totals: { ...record().totals, cacheCreationTokens: 0 },
            }),
          ],
        ],
      ]);
      const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(original))));

      const entry = restored.get("/a.jsonl");
      expect(entry?.records[0]?.cacheReport).toEqual({ read, write });
      expect(entry?.cacheReportUnknown).toBeUndefined();
    }
  });

  it("decodes an 11-slot row as unknown coverage and re-encodes it unchanged", () => {
    // Deleted transcripts cannot be re-parsed for coverage, so their rows
    // keep the old shape across restarts instead of gaining a made-up flag.
    const original = cacheWith([["/a.jsonl", 100, [legacyRecord()]]]);
    const encoded = encodeScanCache(original);
    expect(encoded.files["/a.jsonl"]?.r[0]).toHaveLength(11);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encoded)));
    const entry = restored.get("/a.jsonl");
    // Totals, cost and identity survive; only coverage is absent.
    expect(entry?.records[0]).toEqual(legacyRecord());
    expect(entry?.records[0]?.cacheReport).toBeUndefined();
    expect(entry?.cacheReportUnknown).toBe(true);

    const reencoded = encodeScanCache(restored);
    expect(reencoded.files["/a.jsonl"]?.r[0]).toEqual(encoded.files["/a.jsonl"]?.r[0]);
    expect(reencoded.files["/a.jsonl"]?.r[0]).toHaveLength(11);
  });

  it("flags an entry whose tail rows predate coverage", () => {
    // Main rows without cache writes stay unambiguous, so the flag can only
    // come from the tail.
    const cache = cacheWith([
      ["/a.jsonl", 100, [record({ totals: { ...record().totals, cacheCreationTokens: 0 } })]],
    ]);
    cache.set("/a.jsonl", {
      ...cache.get("/a.jsonl")!,
      tailRecords: [legacyRecord({ dedupeKey: "msg_tail:" })],
    });

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encodeScanCache(cache))));

    expect(restored.get("/a.jsonl")?.cacheReportUnknown).toBe(true);
  });

  it("flags a 12-slot Claude row with cache writes as predating the 1h split", () => {
    // Live parsing keeps a numeric split (0 included) whenever the transcript
    // reported cache_creation, so cache writes without a split slot were
    // cached before the split and priced the 1h share at 5m. The entry must
    // not serve a warm hit; a re-parse rewrites its rows with the split.
    const original = cacheWith([["/a.jsonl", 100, [record()]]]);
    const encoded = encodeScanCache(original);
    expect(encoded.files["/a.jsonl"]?.r[0]).toHaveLength(12);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encoded)));
    const entry = restored.get("/a.jsonl");
    expect(entry?.cacheReportUnknown).toBe(true);
    // Rows for a deleted transcript keep their records; only the warm hit is
    // vetoed.
    expect(entry?.records).toEqual([record()]);
  });

  it("keeps a 12-slot Claude row without cache writes warm", () => {
    // With nothing written there is no 1h share to misprice, so the row is
    // unambiguous and stays a warm hit.
    const original = cacheWith([
      ["/a.jsonl", 100, [record({ totals: { ...record().totals, cacheCreationTokens: 0 } })]],
    ]);
    const encoded = encodeScanCache(original);
    expect(encoded.files["/a.jsonl"]?.r[0]).toHaveLength(12);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encoded)));
    expect(restored.get("/a.jsonl")?.cacheReportUnknown).toBeUndefined();
  });

  it("round-trips a reported-zero 1h split as the 13th slot", () => {
    // The explicit 0 is what keeps the 12-slot rule unambiguous, so it must
    // survive the roundtrip without flagging the entry for a re-parse.
    const parsed = parseClaudeLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-07T04:05:13.944Z",
        sessionId: "s",
        message: {
          id: "msg_1",
          model: "claude-fable-5",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 400,
            cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 0 },
          },
        },
      }),
    );
    expect(parsed?.cacheWriteOneHourTokens).toBe(0);

    const original = cacheWith([["/a.jsonl", 100, [parsed!]]]);
    const encoded = encodeScanCache(original);
    expect(encoded.files["/a.jsonl"]?.r[0]).toHaveLength(13);
    expect(encoded.files["/a.jsonl"]?.r[0]?.[12]).toBe(0);

    const restored = decodeScanCache(JSON.parse(JSON.stringify(encoded)));
    const entry = restored.get("/a.jsonl");
    expect(entry?.cacheReportUnknown).toBeUndefined();
    expect(entry?.records[0]?.cacheWriteOneHourTokens).toBe(0);
  });

  it("drops an entry whose coverage slot is out of range or not an integer", () => {
    for (const bad of [4, -1, 1.5, "1", null, Number.NaN]) {
      const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [legacyRecord()]]]));
      const row = encoded.files["/a.jsonl"]!.r[0]!;
      const poisoned = {
        ...encoded,
        files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[...row, bad]] } },
      };

      expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
    }
  });

  it("drops an entry whose persisted parse state is corrupt", () => {
    // Resuming with a bad reducer state would attach appended usage to the
    // wrong model or replay fork-copied history; that entry must cold parse.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": { ...encoded.files["/a.jsonl"]!, cs: { model: 42 } },
      },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose guard length is outside the supported range", () => {
    // The guard length sizes a Buffer in the reader; a bogus value would make
    // every parse of that file fail and silently drop its usage.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, gl: 1e20 } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("drops an entry whose fast flag is not 0 or 1", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record({ fast: true })]]]));
    const row = encoded.files["/a.jsonl"]!.r[0]!;
    const poisoned = {
      ...encoded,
      files: { "/a.jsonl": { ...encoded.files["/a.jsonl"]!, r: [[...row.slice(0, 10), true]] } },
    };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).has("/a.jsonl")).toBe(false);
  });

  it("rejects a document from the previous cache version", () => {
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const previous = { ...encoded, version: 3 };

    expect(decodeScanCache(JSON.parse(JSON.stringify(previous))).size).toBe(0);
  });

  it("interns repeated model and session strings", () => {
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" }), record()]]]),
    );

    expect(encoded.models).toEqual(["claude-fable-5"]);
    expect(encoded.sessions).toEqual(["session-a"]);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    // A bad cache should cost one cold scan, never a broken page.
    expect(decodeScanCache(null).size).toBe(0);
    expect(decodeScanCache("nonsense").size).toBe(0);
    expect(decodeScanCache({ version: 999, models: [], sessions: [], files: {} }).size).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = encodeScanCache(cacheWith([["/good.jsonl", 100, [record()]]]));
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)));
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("rejects the whole cache when an intern table holds a non-string", () => {
    // models: [1] would pass the undefined guard, put a number in a record's
    // model, and crash lookupRate at aggregate time.
    const encoded = encodeScanCache(cacheWith([["/a.jsonl", 100, [record()]]]));
    const poisoned = { ...encoded, models: [1] };

    expect(decodeScanCache(JSON.parse(JSON.stringify(poisoned))).size).toBe(0);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    // Keeping the surviving rows under the original (size, mtime) would read
    // as a valid warm hit and the file would never be re-parsed.
    const encoded = encodeScanCache(
      cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)));
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});

describe("pruneScanCache", () => {
  const retentionCutoffMs = 1000;

  it("drops entries older than retention", () => {
    const cache = cacheWith([["/old.jsonl", 500, [record()]]]);

    const removed = pruneScanCache(cache, retentionCutoffMs);

    expect(removed).toBe(1);
    expect(cache.size).toBe(0);
  });

  it("keeps entries whose file has disappeared", () => {
    const cache = cacheWith([["/gone.jsonl", 5000, [record()]]]);

    pruneScanCache(cache, retentionCutoffMs);

    expect(cache.size).toBe(1);
  });
});

describe("dedupeWithinFile", () => {
  it("keeps the first record per dedupe key", () => {
    const kept = dedupeWithinFile([
      record({ totals: { ...record().totals, outputTokens: 1 } }),
      record({ totals: { ...record().totals, outputTokens: 999 } }),
      record({ dedupeKey: "msg_2:" }),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept[0]?.totals.outputTokens).toBe(1);
  });

  it("keeps every record that has no dedupe key", () => {
    expect(
      dedupeWithinFile([record({ dedupeKey: null }), record({ dedupeKey: null })]),
    ).toHaveLength(2);
  });
});
