import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { auditVerdict, parseAuditReport } from "./crewLogic.ts";
import { CrewTaskRecoveryJson } from "./crewRecoveryState.ts";

const decodeTask = Schema.decodeOption(CrewTaskRecoveryJson);

type Task = typeof CrewTaskRecoveryJson.Type;
type Report = NonNullable<Task["report"]>;

function summarize(role: Task["role"], model: string, reports: ReadonlyArray<Report>) {
  if (role === "auditor") {
    let needsChanges = 0;
    let provenBlocking = 0;
    let unreadable = 0;
    for (const { result } of reports) {
      // What the auditor said, against what its evidence supports: `auditVerdict` asks for changes
      // from a JSON review only with a proven blocking finding.
      const stated = parseAuditReport(result)?.verdict;
      const backed = auditVerdict(result);
      if (backed === null) unreadable++;
      if (stated === undefined ? backed === "needs-changes" : stated === "needs changes") {
        needsChanges++;
        if (stated !== undefined && backed === "needs-changes") provenBlocking++;
      }
    }
    return { role, model, audits: reports.length, needsChanges, provenBlocking, unreadable };
  }
  return {
    role,
    model,
    tasks: reports.length,
    completed: reports.filter((report) => report.status === "completed").length,
    verified: reports.filter((report) => report.proof?.verdict === "verified").length,
    failed: reports.filter((report) => report.status === "failed").length,
  };
}

/**
 * Finished crew tasks grouped by role and the model that ran them. A task the user stopped says
 * nothing about the model, so it is left out.
 */
export function aggregateCrewScorecard(records: ReadonlyArray<string>) {
  const groups = new Map<string, { role: Task["role"]; model: string; reports: Report[] }>();
  for (const json of records) {
    const task = Option.getOrNull(decodeTask(json));
    if (task === null) continue;
    const { role, report } = task;
    if (
      report === null ||
      report.status === "starting" ||
      report.status === "running" ||
      report.status === "interrupted"
    ) {
      continue;
    }

    const attempt = task.attempts.findLast(
      (entry) => entry.threadId !== undefined && entry.error !== "could not start",
    );
    if (attempt === undefined) continue;
    const { model } = attempt;
    const key = `${role}:${model}`;
    const group = groups.get(key) ?? { role, model, reports: [] };
    group.reports.push(report);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model))
    .map(({ role, model, reports }) => summarize(role, model, reports));
}

/** The scorecard for the last 30 days. Read once when a client opens it; nothing here is stored. */
export const readCrewScorecard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const windowStart = DateTime.formatIso(DateTime.subtract(now, { days: 30 }));
  const windowEnd = DateTime.formatIso(now);
  // Bound recovery decoding to the newest 2,000 finished tasks in the reporting window.
  const records = yield* sql<{ record_json: string }>`
    SELECT record_json FROM crew_tasks
    WHERE updated_at >= ${windowStart} AND updated_at <= ${windowEnd}
      AND json_extract(record_json, '$.report.status') IN
        ('completed', 'failed', 'partial', 'blocked')
    ORDER BY updated_at DESC, task_id DESC
    LIMIT 2000
  `;
  return { windowStart, rows: aggregateCrewScorecard(records.map((row) => row.record_json)) };
});
