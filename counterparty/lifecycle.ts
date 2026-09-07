/**
 * What a seller should do about one entry in a job room.
 *
 * Pure, and separate from `index.ts`, because this is the decision that kept the
 * whole ACP path broken through three deploys — and it is untestable while it lives
 * inside an event handler that needs a live Virtuals connection to reach.
 *
 * The rule, from the SDK's own seller example: the seller names its price when the
 * BUYER'S REQUIREMENT MESSAGE arrives, and submits when escrow is funded. The
 * handler used to open with `if (entry.kind !== "system") return`, which discarded
 * the requirement — a `message`, not a `system` event — and so never priced
 * anything. Every job sat at `open` until the buyer's timeout.
 */

/** The shape this needs off a `JobRoomEntry`; the SDK's type is wider. */
export interface EntryLike {
  kind: string;
  contentType?: string;
  event?: { type?: string };
}

export type SellerAction = "price" | "deliver" | "ignore";

/**
 * `status` is the job's phase (`open`, `budget_set`, `funded`, …). Pricing is only
 * meaningful while the job is still open; anything later has a budget already.
 */
export function sellerAction(entry: EntryLike, status: string): SellerAction {
  if (entry.kind === "message") {
    return entry.contentType === "requirement" && status === "open" ? "price" : "ignore";
  }
  if (entry.kind !== "system") return "ignore";

  const type = entry.event?.type;
  if (type === "job.funded") return "deliver";
  // Belt and braces for the orderings the requirement message misses: a requirement
  // that landed before this listener attached, or a session hydrated on restart.
  if (type === "job.created" && status === "open") return "price";
  return "ignore";
}
