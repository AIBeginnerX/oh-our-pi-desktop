import { describe, expect, it } from "vite-plus/test";

import { sentItemChange, sentItemStatus } from "./ProjectMemorySentToThread.logic";

describe("sentItemStatus", () => {
  it("never claims a recall was confirmed, and flags unconfirmed composer sends", () => {
    expect(sentItemStatus({ via: "recall", state: "external_send_unknown" })).toBe(
      "Recalled by the agent",
    );
    expect(sentItemStatus({ via: "message", state: "provider_accepted" })).toBe(
      "Sent with a message",
    );
    expect(sentItemStatus({ via: "message", state: "external_send_unknown" })).toBe(
      "Sent with a message, delivery unconfirmed",
    );
    expect(sentItemStatus({ via: "message", state: "dispatch_committed" })).toBe(
      "Sending with a message",
    );
  });
});

describe("sentItemChange", () => {
  it("reports deletion ahead of an edit, and nothing for an untouched memory", () => {
    expect(sentItemChange({ deleted: true, changedSinceSent: true })).toBe("deleted");
    expect(sentItemChange({ deleted: false, changedSinceSent: true })).toBe("edited");
    expect(sentItemChange({ deleted: false, changedSinceSent: false })).toBeNull();
  });
});
