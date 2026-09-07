import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initialize, writeWallet } from "../memory/index.ts";
import { performSpend } from "../src/execution/perform.ts";
import { pullWasUnspent } from "../src/wallet/cdp.ts";
import { hermeticSetup, hermeticTeardown, USER } from "./support.ts";
import { walletProvider } from "../src/wallet/index.ts";

/**
 * A purchase that took the money and delivered nothing.
 *
 * Whale Flows answered 502 after 71 seconds. Ward had already pulled the user's
 * $0.001 into the SHARED agent spender — that is the design, the pull has to precede
 * the request — and then told them:
 *
 *   "Execution failed: x402 endpoint returned 502. Nothing was charged beyond gas."
 *
 * The chain said otherwise: the user's smart account was $0.001 lighter and the
 * spender held exactly that. Two separate faults — the money was not returned, and
 * the message asserted something untrue about it.
 */

describe("deciding whether a pull can be returned", () => {
  // The spender is shared, so "does it hold at least the amount?" is the wrong
  // question — that would refund the user out of someone else's float.
  test("still there → the payment never settled, so it goes back", () => {
    expect(pullWasUnspent(0, 0.001, 0.001)).toBe(true);
    expect(pullWasUnspent(5, 5.001, 0.001)).toBe(true);
  });

  test("gone → the endpoint took it, and no refund is owed by Ward", () => {
    expect(pullWasUnspent(0, 0, 0.001)).toBe(false);
    // Someone else's float sitting in the spender must not look like our pull.
    expect(pullWasUnspent(5, 5, 0.001)).toBe(false);
  });

  test("floating-point noise does not decide it", () => {
    expect(pullWasUnspent(0.1, 0.1 + 0.2 - 0.2 + 0.001, 0.001)).toBe(true);
  });
});

describe("what the user is told", () => {
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

  const failWith = async (error: Error) => {
    const provider = walletProvider();
    const original = provider.payX402.bind(provider);
    provider.payX402 = async () => {
      throw error;
    };
    try {
      return await performSpend({
        userId: USER,
        actionType: "x402_data_purchase",
        amountUsd: 0.001,
        idempotencyKey: `u-${Math.random()}`,
        endpoint: {
          name: "Whale Flows",
          url: "https://example.test/x402/whale-flows",
          method: "POST",
          cost_usd: 0.001,
        },
      });
    } finally {
      provider.payX402 = original;
    }
  };

  test("a failure that accounted for the money is not contradicted", async () => {
    const outcome = await failWith(
      Object.assign(
        new Error("the endpoint returned 502 — your $0.001 USDC was returned to your wallet"),
        { moneyAccounted: true },
      ),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("was returned to your wallet");
    // The blanket claim is what made the old message a lie.
    expect(outcome.message).not.toContain("Nothing was charged beyond gas");
  });

  test("a failure before any money moved still says so", async () => {
    const outcome = await failWith(new Error("connect ETIMEDOUT"));

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Nothing was charged beyond gas");
  });
});

describe("asking before paying", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("an address sent to a ticker-only endpoint is caught, not bought", async () => {
    const { loadCatalog } = await import("../src/execution/catalog.ts");
    const { subjectMismatch } = await import("../src/execution/catalog.ts");
    const whale = (await loadCatalog()).find((e) => e.id === "whale-flows")!;

    // The exact request that produced a 502: a project SEARCH, given a contract
    // address in its `ticker` field.
    const complaint = subjectMismatch(whale, "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196");
    expect(complaint).toContain("ticker or project name");
    expect(complaint).toContain("not by contract address");
  });

  test("a ticker is fine for the same endpoint", async () => {
    const { loadCatalog, subjectMismatch } = await import("../src/execution/catalog.ts");
    const whale = (await loadCatalog()).find((e) => e.id === "whale-flows")!;
    expect(subjectMismatch(whale, "AERO")).toBeNull();
  });

  test("an endpoint that takes either is never in the way", async () => {
    const { loadCatalog, subjectMismatch } = await import("../src/execution/catalog.ts");
    const price = (await loadCatalog()).find((e) => e.subject_kind === "any")!;
    expect(subjectMismatch(price, "AERO")).toBeNull();
    expect(subjectMismatch(price, "0x4200000000000000000000000000000000000006")).toBeNull();
  });
});
