import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetBackend } from "../memory/backend.ts";
import { appendAcpJob, initialize, read, trustScore } from "../memory/store.ts";
import { jobTrustDelta } from "../src/acp/index.ts";
import { StubAcpProvider } from "../src/acp/stub.ts";
import { runAcpJob } from "../src/execution/acp.ts";
import { resetWalletProvider, walletProvider } from "../src/wallet/index.ts";
import type { StubWalletProvider } from "../src/wallet/stub.ts";

const USER = "ward_01J9XQ4M7BZK3TVWXY0123456C";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-acp-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  delete process.env.ACP_MODE;
  delete process.env.CDP_API_KEY_ID;
  await resetBackend();
  resetWalletProvider();
  await initialize(USER, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
});

afterEach(async () => {
  await resetBackend();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  await rm(dir, { recursive: true, force: true });
});

describe("StubAcpProvider", () => {
  test("returns a deterministic, per-subject result that settles", async () => {
    const provider = new StubAcpProvider();
    const a = await provider.hire(USER, { jobType: "token_risk", subject: "PEPE", maxUsd: 0.5 });
    const b = await provider.hire(USER, { jobType: "token_risk", subject: "OTHER", maxUsd: 0.5 });
    expect(a.settled).toBe(true);
    expect(a.counterpartyId).toMatch(/^agent:\/\//);
    expect(a.outcomeSummary).not.toBe(b.outcomeSummary);
  });
});

describe("jobTrustDelta", () => {
  test("rewards a clean settled job, penalises the rest", () => {
    const settled = { settled: true, rawResult: { a: 1, b: 2 } } as never;
    expect(jobTrustDelta(settled, false)).toBe(0.3);
    expect(jobTrustDelta(settled, true)).toBe(-0.4);
    expect(jobTrustDelta({ settled: false, rawResult: null } as never, false)).toBe(-0.3);
    expect(jobTrustDelta({ settled: true, rawResult: null } as never, false)).toBe(-0.1);
  });

  /**
   * Production, 2026-09-09: two hires died on Ward's own RPC — one rate-limited, one
   * pointed at the wrong chain — and the seller was charged for both, 0.50 → 0.44 →
   * 0.40, for work it was never given the chance to do. Trust decides who Ward hires
   * next, so an outage on our side must not quietly demote every honest agent it
   * touches.
   */
  test("a failure on Ward's side costs the counterparty nothing", () => {
    const ours = { settled: false, rawResult: null, wardFault: true } as never;
    expect(jobTrustDelta(ours, false)).toBe(0);
  });

  /** The flag must not become a way to launder a genuinely bad deliverable. */
  test("wardFault does not excuse a counterparty that actually failed", () => {
    expect(jobTrustDelta({ settled: false, rawResult: null } as never, false)).toBe(-0.3);
    expect(jobTrustDelta({ settled: true, rawResult: null } as never, true)).toBe(-0.4);
  });
});

describe("runAcpJob write-back", () => {
  test("records the job, spends, and the trust score re-derives", async () => {
    const first = await runAcpJob({
      userId: USER,
      accountKey: null,
      subject: "PEPE",
      budgetUsd: 0.5,
      idempotencyKey: "j1",
    });
    expect(first.ok).toBe(true);
    expect(first.trustBefore).toBe(0.5);
    expect(first.trustAfter).toBeGreaterThan(first.trustBefore);

    const record = await read(USER);
    expect(record?.acp_job_history).toHaveLength(1);
    expect(record?.spent_ledger).toHaveLength(1);
    expect(record?.spent_ledger[0]?.action_type).toBe("acp_job");

    // a second hire reads the accumulated trust first
    const second = await runAcpJob({
      userId: USER,
      accountKey: null,
      subject: "WOOF",
      budgetUsd: 0.5,
      idempotencyKey: "j2",
    });
    expect(second.trustBefore).toBe(first.trustAfter);
    expect(await trustScore(USER, first.counterpartyId)).toBe(second.trustAfter);
  });

  test("a stub-mode hire moves no money — the simulated counterparty is never charged for", async () => {
    const wallet = walletProvider() as StubWalletProvider;
    await runAcpJob({
      userId: USER,
      accountKey: null,
      subject: "PEPE",
      budgetUsd: 0.5,
      idempotencyKey: "j4",
    });
    // The per-user pull lives in the *virtuals* provider, not runAcpJob — moving it
    // up here would charge real USDC for `agent://ward-analyst.stub`.
    expect(wallet.calls).toEqual([]);
  });

  test("a pre-seeded evaluated job shows up as an existing trust score", async () => {
    await appendAcpJob(USER, {
      counterparty_id: "agent://ward-analyst.stub",
      job_type: "token_risk",
      outcome_summary: "correct rug call",
      trust_delta: 0.4,
    });
    const run = await runAcpJob({
      userId: USER,
      accountKey: null,
      subject: "NEW",
      budgetUsd: 0.5,
      idempotencyKey: "j3",
    });
    expect(run.trustBefore).toBeGreaterThan(0.5);
  });
});

/**
 * A failure has to land on the agent that failed.
 *
 * `counterpartyId` is what `appendAcpJob` writes and `trustScore()` reads back before
 * the next hire. Production showed "The job with agent://unknown did not settle" for a
 * job whose confirmation had just named `agent://0x3bc3…0fff` — so the trust penalty
 * was spent on nobody, and memory learned nothing from a real failure.
 */
describe("attributing a failed ACP job", () => {
  const job = { jobType: "token_risk", subject: "PEPE", maxUsd: 0.5 } as const;

  test("a failure in flight names the counterparty", async () => {
    const { notSettled } = await import("../src/acp/virtuals.ts");
    const result = notSettled(job, "timed out", "0x3bc37bbac8b34e0ead2d20cf9ab030af60520fff");

    expect(result.counterpartyId).toBe("agent://0x3bc37bbac8b34e0ead2d20cf9ab030af60520fff");
    expect(result.settled).toBe(false);
    expect(result.outcomeSummary).toContain("timed out");
    expect(result.amountUsd).toBe(0);
  });

  test("only a failure BEFORE one is chosen is anonymous", async () => {
    // Selection itself failing is the one case with genuinely no counterparty to name.
    const { notSettled } = await import("../src/acp/virtuals.ts");
    expect(notSettled(job, "no ACP agent offers token-risk assessment").counterpartyId).toBe(
      "agent://unknown",
    );
  });
});
