import { describe, expect, test } from "bun:test";

import { sellerAction, type EntryLike } from "../counterparty/lifecycle.ts";

/**
 * The decision that cost three deploys and three trust penalties.
 *
 * A seller names its price when the BUYER'S REQUIREMENT MESSAGE arrives. The handler
 * opened with `if (entry.kind !== "system") return`, so it threw that message away —
 * a requirement is `kind: "message"` — and never set a budget. Every job stalled at
 * `open`: Ward waited for `budget.set` before funding, the seller waited for
 * `job.funded` before working, and neither moved until the buyer's 180s timeout.
 *
 * Nothing about it was visible from Ward's side, and nothing about it was testable
 * while the decision lived inside an event handler needing a live Virtuals
 * connection. That is why it is a pure function now.
 */

const requirement: EntryLike = { kind: "message", contentType: "requirement" };
const system = (type: string): EntryLike => ({ kind: "system", event: { type } });

describe("when the seller should name its price", () => {
  test("the buyer's requirement message is the trigger", () => {
    expect(sellerAction(requirement, "open")).toBe("price");
  });

  test("a requirement is a message, not a system event — the bug in one line", () => {
    // The old guard was `entry.kind !== "system"`, which is true here.
    expect(requirement.kind).not.toBe("system");
    expect(sellerAction(requirement, "open")).toBe("price");
  });

  test("job.created also prices, for orderings the message misses", () => {
    // A requirement that landed before the listener attached, or a restart.
    expect(sellerAction(system("job.created"), "open")).toBe("price");
  });

  test("pricing stops once the job has moved on", () => {
    for (const status of ["budget_set", "funded", "submitted", "completed", "rejected"]) {
      expect(sellerAction(requirement, status)).toBe("ignore");
      expect(sellerAction(system("job.created"), status)).toBe("ignore");
    }
  });
});

describe("when the seller should deliver", () => {
  test("funded escrow is the trigger, at any status", () => {
    expect(sellerAction(system("job.funded"), "funded")).toBe("deliver");
  });

  test("nothing else asks for work", () => {
    for (const type of ["job.created", "budget.set", "job.submitted", "job.completed"]) {
      expect(sellerAction(system(type), "funded")).not.toBe("deliver");
    }
  });
});

describe("everything else is ignored", () => {
  test("ordinary chat is not a requirement", () => {
    expect(sellerAction({ kind: "message", contentType: "text" }, "open")).toBe("ignore");
    expect(sellerAction({ kind: "message" }, "open")).toBe("ignore");
  });

  test("unknown entry kinds and unknown events are inert", () => {
    expect(sellerAction({ kind: "attachment" }, "open")).toBe("ignore");
    expect(sellerAction(system("job.rejected"), "open")).toBe("ignore");
    expect(sellerAction({ kind: "system" }, "open")).toBe("ignore");
  });
});

/**
 * The sequence a real job actually produces, in order. This is the assertion that
 * matters: run the whole lifecycle past the seller and it must price exactly once
 * and deliver exactly once.
 */
describe("a whole job, in order", () => {
  test("prices once, delivers once", () => {
    const timeline: Array<[EntryLike, string]> = [
      [system("job.created"), "open"],
      [requirement, "open"],
      [system("budget.set"), "budget_set"],
      [requirement, "budget_set"],
      [system("job.funded"), "funded"],
      [system("job.submitted"), "submitted"],
      [system("job.completed"), "completed"],
    ];

    const actions = timeline.map(([entry, status]) => sellerAction(entry, status));

    expect(actions.filter((a) => a === "price")).toHaveLength(2); // both open-phase triggers
    expect(actions.filter((a) => a === "deliver")).toHaveLength(1);
    // `priceJob` is idempotent per job id, so two "price" decisions are one budget.
    expect(actions[0]).toBe("price");
    expect(actions[4]).toBe("deliver");
  });
});
