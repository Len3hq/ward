import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendRevocation, initialize, read, writeWallet } from "../memory/index.ts";
import { tableIntent } from "../src/agent/intent.ts";
import { performSpend } from "../src/execution/perform.ts";
import { resolveUser } from "../src/identity/index.ts";
import { hermeticSetup, hermeticTeardown, walletCalls } from "./support.ts";

/**
 * Sending to an external address, and getting a swap's proceeds back to the user.
 *
 * The swap half exists because of a real defect: the bought token was left in the
 * shared agent spender and never forwarded, so Ward reported a completed swap while
 * the user's smart account held nothing new. A swap is not done until the proceeds
 * are the user's.
 *
 * Swap / send are switched off in production (`src/agent/transfers.ts`); this file
 * keeps the dormant execution path honest. `hermeticSetup` enables transfers, so
 * these run — see `test/transfers-disabled.test.ts` for the shipped (off) behaviour.
 */

const TG = "700100200";
const DEST = "0x1111111111111111111111111111111111111111";
let userId = "";

beforeEach(async () => {
  await hermeticSetup();
  ({ userId } = await resolveUser("telegram", TG));
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  await writeWallet(userId, {
    account_key: userId,
    smart_account: `0x${"1".repeat(40)}`,
    agent_spender: `0x${"2".repeat(40)}`,
    spend_permission: {
      token: "USDC",
      allowance_usd: 100,
      period_seconds: 86_400,
      granted_tx: "0xabc",
      status: "active",
    },
  });
});

afterEach(hermeticTeardown);

describe("recognising a send", () => {
  test("needs both an amount and an address", () => {
    expect(tableIntent(`send $10 usdc to ${DEST}`)).toMatchObject({
      action_type: "send",
      amount_usd: 10,
      token: DEST,
    });
    expect(tableIntent(`transfer $5 to ${DEST}`)?.action_type).toBe("send");
    expect(tableIntent(`withdraw $5 to ${DEST}`)?.action_type).toBe("send");
  });

  /** Without an address there is nothing to send to, and guessing one is unthinkable. */
  test("plain 'send me $10' is not a send", () => {
    expect(tableIntent("send me $10")?.action_type).not.toBe("send");
  });

  test("is not confused with a swap", () => {
    expect(tableIntent("swap $20 usdc for eth")?.action_type).toBe("swap");
  });
});

describe("executing a send", () => {
  test("moves the money and records it on the shared ledger", async () => {
    const outcome = await performSpend({
      userId,
      actionType: "send",
      amountUsd: 10,
      idempotencyKey: "s1",
      destination: DEST,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain(DEST);
    expect(walletCalls()).toContain("sendUsdc");

    const record = await read(userId);
    expect(record?.spent_ledger[0]).toMatchObject({ action_type: "send", amount_usd: 10 });
  });

  test("counts against the same daily cap as everything else", async () => {
    // $50 per action, $100 a day: two full-size sends fit, a third of any size does not.
    for (const [i, amount] of [50, 50].entries()) {
      const outcome = await performSpend({
        userId,
        actionType: "send",
        amountUsd: amount,
        idempotencyKey: `s${i}`,
        destination: DEST,
      });
      expect(outcome.ok).toBe(true);
    }

    const third = await performSpend({
      userId,
      actionType: "send",
      amountUsd: 10,
      idempotencyKey: "s3",
      destination: DEST,
    });

    expect(third.ok).toBe(false);
    expect((await read(userId))?.spent_ledger).toHaveLength(2);
  });

  test("shares that cap with swaps — one ledger, one budget", async () => {
    await performSpend({
      userId,
      actionType: "swap",
      amountUsd: 50,
      idempotencyKey: "w1",
      pair: "USDC/ETH",
    });
    await performSpend({
      userId,
      actionType: "send",
      amountUsd: 50,
      idempotencyKey: "s1",
      destination: DEST,
    });

    const third = await performSpend({
      userId,
      actionType: "send",
      amountUsd: 5,
      idempotencyKey: "s2",
      destination: DEST,
    });

    expect(third.ok).toBe(false);
  });

  test("is a revocable action type like any other", async () => {
    await appendRevocation(userId, { action_type: "send", reason: "paused" });

    const outcome = await performSpend({
      userId,
      actionType: "send",
      amountUsd: 10,
      idempotencyKey: "s1",
      destination: DEST,
    });

    expect(outcome.ok).toBe(false);
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });

  test("refuses without a valid address rather than sending anywhere", async () => {
    for (const destination of [undefined, "not-an-address", "0x123"]) {
      const outcome = await performSpend({
        userId,
        actionType: "send",
        amountUsd: 10,
        idempotencyKey: `s-${destination}`,
        destination,
      });
      expect(outcome.ok).toBe(false);
    }
    expect(walletCalls()).not.toContain("sendUsdc");
  });
});

describe("a swap's proceeds reach the user", () => {
  test("the bought token is swept to the smart account", async () => {
    const outcome = await performSpend({
      userId,
      actionType: "swap",
      amountUsd: 20,
      idempotencyKey: "w1",
      pair: "USDC/ETH",
    });

    expect(outcome.ok).toBe(true);
    // The sweep is a distinct step, so it is a distinct assertion.
    expect(walletCalls()).toContain("swap");
    expect(walletCalls()).toContain("sweepToUser");
    expect(outcome.message).toContain("Sent to your smart account");
  });

  test("a swap whose proceeds did NOT move says so, rather than claiming success", async () => {
    const { walletProvider } = await import("../src/wallet/index.ts");
    const provider = walletProvider();
    const original = provider.swap.bind(provider);
    // A sweep that silently fails is the exact defect this phase fixed; the message
    // must never read like a completed swap.
    provider.swap = async (key, request) => {
      const result = await original(key, request);
      return { ...result, sweepTx: undefined };
    };

    const outcome = await performSpend({
      userId,
      actionType: "swap",
      amountUsd: 20,
      idempotencyKey: "w2",
      pair: "USDC/ETH",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("could not be moved to your smart account");
    expect(outcome.message).toContain("still");
  });
});

/**
 * A failed spend used to return its reason to chat and log NOTHING, so a production
 * swap could die on chain while `railway logs` showed a perfectly healthy process —
 * the only copy of the error sat in the user's Telegram thread. Diagnosing one cost
 * an afternoon, which is what this guards against.
 */
describe("a failed spend reaches the server log", () => {
  /** Captures both streams: a thrown spend is an `error`, a gate block only a `warn`. */
  function captureErrors(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    const record = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };
    console.error = record;
    console.warn = record;
    const realLog = console.log;
    console.log = record;
    return {
      lines,
      restore: () => {
        console.error = realError;
        console.warn = realWarn;
        console.log = realLog;
      },
    };
  }

  test("a provider that throws is logged with the action, the amount and the user", async () => {
    const { walletProvider } = await import("../src/wallet/index.ts");
    const provider = walletProvider();
    const original = provider.swap.bind(provider);
    provider.swap = async () => {
      throw new Error("execution reverted: no route for 0.1 USDC");
    };

    const capture = captureErrors();
    let outcome;
    try {
      outcome = await performSpend({
        userId,
        actionType: "swap",
        amountUsd: 0.1,
        idempotencyKey: "log1",
        pair: "USDC/ETH",
      });
    } finally {
      capture.restore();
      provider.swap = original;
    }

    expect(outcome.ok).toBe(false);
    const logged = capture.lines.join("\n");
    // One searchable line, same facts — see `src/log.ts`.
    expect(logged).toContain("event=spend.failed");
    expect(logged).toContain("action=swap");
    expect(logged).toContain("amount_usd=0.1");
    expect(logged).toContain(userId);
    expect(logged).toContain("no route for 0.1 USDC");
  });

  test("a gate block at execution time is logged — it means something changed", async () => {
    const capture = captureErrors();
    let outcome;
    try {
      // Over the $50 per-action cap, so the gate refuses after confirmation.
      outcome = await performSpend({
        userId,
        actionType: "swap",
        amountUsd: 500,
        idempotencyKey: "log2",
        pair: "USDC/ETH",
      });
    } finally {
      capture.restore();
    }

    expect(outcome.ok).toBe(false);
    const logged = capture.lines.join("\n");
    expect(logged).toContain("event=spend.blocked");
    expect(logged).toContain("amount_usd=500");
    expect(logged).toContain("per-action limit");
  });
});
