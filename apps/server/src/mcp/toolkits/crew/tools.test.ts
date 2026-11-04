import { CREW_WHY_MAX_LENGTH } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CrewToolkit } from "./tools.ts";

describe("crew tool schemas: why", () => {
  const stop = CrewToolkit.tools.crew_stop.parametersSchema;
  const delegate = CrewToolkit.tools.crew_delegate.parametersSchema;

  it("accepts any why and leaves bounding to the server", () => {
    for (const why of ["", "  ", "x".repeat(CREW_WHY_MAX_LENGTH + 100), "Too slow."]) {
      assert.strictEqual(Schema.decodeUnknownSync(stop)({ all: true, why }).why, why);
      const input = { role: "worker", task: "Do it", title: "Do it", why };
      assert.strictEqual(Schema.decodeUnknownSync(delegate)(input).why, why);
    }
  });
});
