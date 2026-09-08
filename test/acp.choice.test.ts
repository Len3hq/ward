import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendAcpJob, initialize } from "../memory/index.ts";
import { renderAcpReport } from "../src/execution/acp-report.ts";
import { chooseCounterparty } from "../src/execution/acp.ts";
import { acpProvider, resetAcpProvider } from "../src/acp/index.ts";
import type { AcpCandidate } from "../src/acp/provider.ts";
import { hermeticSetup, hermeticTeardown, USER } from "./support.ts";

/**
 * Two things the user paid for and did not get.
 *
 * The report: `rawResult` was validated, written to memory, and dropped, so the reply
 * said "Result: job completed" and nothing about what the job found — the score, the
 * band, the named red flags, all discarded.
 *
 * The choice: Ward hired whoever `ACP_COUNTERPARTY_WALLET` pinned, or whoever the
 * marketplace ranked first. It kept a trust history per counterparty and never once
 * used it to decide who to hire — which is the only reason to keep one.
 */

beforeEach(hermeticSetup);
afterEach(async () => {
  await hermeticTeardown();
  resetAcpProvider();
});

describe("showing what the counterparty delivered", () => {
  const report = {
    subject: "VVV",
    address: "0xacf6c2a4c05d8d0e6d0c7c3e5f0b1a2c3d4e5f60",
    resolved_by: "dexscreener: deepest Base pool for VVV",
    risk_score: 35,
    band: "elevated",
    scale: "0 = worst, 100 = safest",
    flags: ["owner can mint new supply", "LP not locked"],
    sources: [{ name: "GoPlus", url: "https://x", raw_sha256: "ab" }],
  };

  test("the band, the score and every flag reach the user", () => {
    const out = renderAcpReport(report)!;
    expect(out).toContain("ELEVATED");
    expect(out).toContain("35/100");
    expect(out).toContain("owner can mint new supply");
    expect(out).toContain("LP not locked");
  });

  test("the scale is shown, because a score with no direction is unusable", () => {
    expect(renderAcpReport(report)).toContain("0 = worst, 100 = safest");
  });

  /**
   * A ticker is resolved by heuristic, so a report about the wrong token has to be
   * recognisable as one. That is the entire purpose of `resolved_by`.
   */
  test("which address was actually scored, and how it got there", () => {
    const out = renderAcpReport(report)!;
    expect(out).toContain("0xacf6c2a4c05d8d0e6d0c7c3e5f0b1a2c3d4e5f60");
    expect(out).toContain("deepest Base pool");
  });

  test("a clean token says so rather than showing an empty list", () => {
    expect(renderAcpReport({ ...report, flags: [] })).toContain("No red flags");
  });

  test("a shape this does not know is shown, not hidden — they still paid", () => {
    expect(renderAcpReport({ answer: 42 })).toContain("```json");
  });

  test("nothing at all is nothing, so the caller can omit the section", () => {
    expect(renderAcpReport(null)).toBeNull();
    expect(renderAcpReport("   ")).toBeNull();
  });
});

/** A directory of several sellers, so there is a real choice to make. */
function stubDirectory(candidates: AcpCandidate[]): void {
  const provider = acpProvider() as unknown as {
    candidates: (jobType: string, limit: number) => Promise<AcpCandidate[]>;
  };
  provider.candidates = async () => candidates;
}

describe("choosing who to hire", () => {
  const alice = "agent://0xaaa0000000000000000000000000000000000001";
  const bob = "agent://0xbbb0000000000000000000000000000000000002";

  beforeEach(async () => {
    await initialize(USER, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });
  });

  test("with nothing remembered, the marketplace's own order wins", async () => {
    stubDirectory([
      { id: alice, name: "Alice" },
      { id: bob, name: "Bob" },
    ]);

    const choice = await chooseCounterparty(USER, "token_risk");

    expect(choice.counterpartyId).toBe(alice);
    expect(choice.considered).toBe(2);
  });

  test("an agent that delivered before is preferred over the top listing", async () => {
    stubDirectory([
      { id: alice, name: "Alice" },
      { id: bob, name: "Bob" },
    ]);
    await appendAcpJob(USER, {
      counterparty_id: bob,
      job_type: "token_risk",
      outcome_summary: "job completed",
      trust_delta: 0.3,
    });

    const choice = await chooseCounterparty(USER, "token_risk");

    // Bob is second in the directory and first in Ward's memory. Memory wins —
    // that is the only reason to keep a trust history.
    expect(choice.counterpartyId).toBe(bob);
    expect(choice.trust).toBeGreaterThan(0.5);
  });

  test("an agent that failed is demoted below an unproven one", async () => {
    stubDirectory([
      { id: alice, name: "Alice" },
      { id: bob, name: "Bob" },
    ]);
    await appendAcpJob(USER, {
      counterparty_id: alice,
      job_type: "token_risk",
      outcome_summary: "did not settle: timed out",
      trust_delta: -0.3,
    });

    const choice = await chooseCounterparty(USER, "token_risk");

    expect(choice.counterpartyId).toBe(bob);
  });

  test("one candidate is not a choice, and says so", async () => {
    stubDirectory([{ id: alice }]);
    expect((await chooseCounterparty(USER, "token_risk")).considered).toBe(1);
  });

  test("an empty directory falls back rather than throwing", async () => {
    stubDirectory([]);
    const choice = await chooseCounterparty(USER, "token_risk");
    expect(choice.counterpartyId).toBeTruthy();
    expect(choice.considered).toBe(0);
  });
});
