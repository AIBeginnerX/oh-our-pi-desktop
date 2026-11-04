import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The thread's own OOP Crew (`thread.crew-set`); null means it runs the default crew. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "crew_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN crew_json TEXT
    `;
  }
});
