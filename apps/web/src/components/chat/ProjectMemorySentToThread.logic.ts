import type { ProjectMemorySentItem } from "@t3tools/contracts";

/**
 * How one send reached the provider, as an English message key for `t()`.
 * `external_send_unknown` means delivery was not confirmed, which is the only
 * state a `memory_recall` send is ever recorded in, so recall needs no suffix.
 */
export function sentItemStatus(item: Pick<ProjectMemorySentItem, "via" | "state">): string {
  if (item.via === "recall") return "Recalled by the agent";
  switch (item.state) {
    case "provider_accepted":
      return "Sent with a message";
    case "external_send_unknown":
      return "Sent with a message, delivery unconfirmed";
    case "dispatch_committed":
      return "Sending with a message";
  }
}

/**
 * What changed after the send, if anything. A deleted memory wins over an edit
 * because its text is gone, not merely newer than what the provider saw.
 */
export function sentItemChange(
  item: Pick<ProjectMemorySentItem, "deleted" | "changedSinceSent">,
): "deleted" | "edited" | null {
  if (item.deleted) return "deleted";
  return item.changedSinceSent ? "edited" : null;
}
