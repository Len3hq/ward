import { afterEach, describe, expect, test } from "bun:test";

import type { UserAuthorization } from "../memory/index.ts";
import { evaluateGate } from "../src/execution/gate.ts";

const base: UserAuthorization = {
  risk_label: "moderate",
  standing_caps: { per_action_limit_usd: 50, daily_limit_usd: 100 },
  spent_ledger: [],
  revocation_log: [],
  acp_job_history: [],
  x402_ledger: [],
};

function gate(over: Partial<Parameters<typeof evaluateGate>[0]> = {}) {
  return evaluateGate({
    record: base,
    actionType: "swap",
    amountUsd: 20,
    spentTodayUsd: 0,
    revoked: false,
    onchainAllowanceUsd: null,
    ...over,
  });
}

afterEach(() => {
  delete process.env.WARD_AUTO_APPROVE_USD;
});

describe("evaluateGate", () => {
  test("allows within limits, and needs approval by default", () => {
    expect(gate()).toMatchObject({ allow: true, needsApproval: true, executableUsd: 20 });
  });

  test("denies a revoked action type", () => {
    expect(gate({ revoked: true })).toMatchObject({ allow: false, executableUsd: 0 });
  });

  test("denies over the per-action limit", () => {
    expect(gate({ amountUsd: 60 }).reason).toMatch(/per-action limit/);
  });

  test("denies over the memory daily cap", () => {
    expect(gate({ amountUsd: 40, spentTodayUsd: 70 }).reason).toMatch(/daily cap/);
  });

  test("the tighter of memory and on-chain binds", () => {
    // $30 on-chain allowance, $0 spent, $50 per-action — on-chain wins
    const r = gate({ amountUsd: 40, onchainAllowanceUsd: 30 });
    expect(r.allow).toBe(false);
    expect(r.reason).toMatch(/on-chain allowance/);
  });

  test("first-time endpoint forces approval even under the auto-limit", () => {
    process.env.WARD_AUTO_APPROVE_USD = "10";
    expect(
      gate({ actionType: "x402_data_purchase", amountUsd: 2, endpointSeen: false }),
    ).toMatchObject({
      allow: true,
      needsApproval: true,
    });
    expect(
      gate({ actionType: "x402_data_purchase", amountUsd: 2, endpointSeen: true }),
    ).toMatchObject({
      allow: true,
      needsApproval: false,
    });
  });

  test("a conservative user always needs approval", () => {
    process.env.WARD_AUTO_APPROVE_USD = "100";
    const conservative = { ...base, risk_label: "conservative" as const };
    expect(
      evaluateGate({
        record: conservative,
        actionType: "swap",
        amountUsd: 5,
        spentTodayUsd: 0,
        revoked: false,
        onchainAllowanceUsd: null,
      }).needsApproval,
    ).toBe(true);
  });
});
