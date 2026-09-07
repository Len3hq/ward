import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendSpend, initialize, spentToday, writeWallet } from "../memory/index.ts";
import { performSpend } from "../src/execution/perform.ts";
import { hermeticSetup, hermeticTeardown, USER } from "./support.ts";
import { walletProvider } from "../src/wallet/index.ts";
import type { X402Request } from "../src/wallet/provider.ts";

/**
 * Sub-cent money.
 *
 * "Give me smart money positioning insight" → "Buy … (~$0.001) … Confirm?" → yes →
 * **"the endpoint asks $0.001 USDC, over the $0 cap you approved"**, with $12 of
 * allowance sitting unused. The cap was computed as `Math.round(0.001 * 1.5 * 100) /
 * 100`, which is zero: cent-precision arithmetic applied to prices that are tenths
 * of a cent. Real x402 endpoints are priced there, so this is the normal case, not
 * an edge one.
 */

beforeEach(async () => {
  await hermeticSetup();
  await initialize(USER, {
    risk_label: "moderate",
    per_action_limit_usd: 5,
    daily_limit_usd: 12,
  });
  await writeWallet(USER, {
    account_key: USER,
    smart_account: `0x${"1".repeat(40)}`,
    agent_spender: `0x${"2".repeat(40)}`,
    spend_permission: {
      token: "USDC",
      allowance_usd: 12,
      period_seconds: 86_400,
      granted_tx: "0xabc",
      status: "active",
    },
  });
});
afterEach(hermeticTeardown);

const endpoint = {
  name: "Smart Money Positioning",
  url: "https://example.test/x402/smart-money",
  method: "POST",
  body: { lookback_days: 7 },
  cost_usd: 0.001,
};

describe("the cap handed to the payment", () => {
  test("leaves room above a $0.001 price instead of collapsing to $0", async () => {
    const provider = walletProvider();
    const seen: X402Request[] = [];
    const original = provider.payX402.bind(provider);
    provider.payX402 = async (key, request) => {
      seen.push(request);
      return original(key, request);
    };

    try {
      const outcome = await performSpend({
        userId: USER,
        actionType: "x402_data_purchase",
        amountUsd: endpoint.cost_usd,
        idempotencyKey: "sub-cent-1",
        endpoint,
      });
      expect(outcome.ok).toBe(true);
    } finally {
      provider.payX402 = original;
    }

    const request = seen[0]!;
    // 1.5×, rounded UP at USDC's six decimals — never down to zero.
    expect(request.maxUsd).toBeCloseTo(0.0015, 6);
    expect(request.maxUsd).toBeGreaterThan(endpoint.cost_usd);
  });

  test("a purchase at a real endpoint price goes through", async () => {
    const outcome = await performSpend({
      userId: USER,
      actionType: "x402_data_purchase",
      amountUsd: 0.001,
      idempotencyKey: "sub-cent-2",
      endpoint,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).not.toContain("over the $0 cap");
  });
});

describe("the daily cap counts sub-cent spends", () => {
  test("$0.001 purchases are not rounded away to nothing", async () => {
    for (let i = 0; i < 3; i++) {
      await appendSpend(USER, {
        action_type: "x402_data_purchase",
        amount_usd: 0.001,
        tx_hash: `0x${i}`,
        idempotency_key: `k${i}`,
        via_token: null,
      });
    }
    // Rounded to cents this was $0.00, so micro-purchases never touched the cap.
    expect(await spentToday(USER)).toBeCloseTo(0.003, 6);
  });
});
