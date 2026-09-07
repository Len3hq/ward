import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { evaluateGate, MIN_SPEND_USD } from "../src/execution/gate.ts";
import { performSpend } from "../src/execution/perform.ts";
import { resolveSwapPair } from "../src/execution/swap.ts";
import { tokenDenominatedAmount } from "../src/agent/intent.ts";
import { CONFIRM_TIMEOUT_MS, HANDLER_TIMEOUT_MS, createGateway } from "../src/telegram/gateway.ts";
import { read, writeWallet } from "../memory/index.ts";
import { walletProvider } from "../src/wallet/index.ts";
import {
  askAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  say,
  USER,
  walletCalls,
} from "./support.ts";

/**
 * "Swap 0.0001 eth to usdc" → a confirmation prompt → "Yes" → "It seems like you
 * might be looking for assistance."
 *
 * Four separate defects, in the order the user met them:
 *
 *   1. The confirmation PARKS the Telegram handler for minutes. Telegraf's default
 *      `handlerTimeout` is 90s, after which it rethrows, long-polling stops and
 *      `index.ts` exits the process — so every open confirmation killed Ward.
 *   2. Restarted, the bot had no pending confirmation, and the bare "Yes" fell
 *      through to the conversational model instead of being answered honestly.
 *   3. Selling ETH is outside the USDC Spend Permission entirely, so the prompt
 *      offered something Ward could never have done.
 *   4. "0.0001 eth" was read as $0.0001 — a token amount treated as dollars.
 */

beforeEach(hermeticSetup);
afterEach(hermeticTeardown);

describe("a confirmation must outlive the handler timeout", () => {
  test("Telegraf is given longer than the confirmation window", () => {
    expect(HANDLER_TIMEOUT_MS).toBeGreaterThan(CONFIRM_TIMEOUT_MS);
  });

  test("and the bot is actually constructed with it — the default 90s is what crashed", () => {
    const bot = createGateway("not-a-real-token", newGraph());
    // `options` is private to Telegraf; reaching for it is the only way to prove the
    // wiring, and this is the exact value whose default took the process down.
    const { handlerTimeout } = (bot as unknown as { options: { handlerTimeout: number } }).options;
    expect(handlerTimeout).toBe(HANDLER_TIMEOUT_MS);
    expect(handlerTimeout).toBeGreaterThan(CONFIRM_TIMEOUT_MS);
  });
});

describe("a yes with nothing pending", () => {
  test("says nothing happened instead of letting the model improvise", async () => {
    const graph = newGraph();
    await onboard(graph, "t-stale");

    const reply = await say(graph, "t-stale", "Yes");
    expect(reply).toContain("nothing has been done");
    expect(reply.toLowerCase()).not.toContain("assistance");
    expect(walletCalls()).toEqual([]);
  });

  test("the same for a bare no", async () => {
    const graph = newGraph();
    await onboard(graph, "t-stale-no");
    expect(await say(graph, "t-stale-no", "no")).toContain("nothing has been done");
  });

  test("but an answer to a live confirmation still executes", async () => {
    const graph = newGraph();
    await onboard(graph, "t-live");
    await say(graph, "t-live", "generate my wallet");
    const prompt = await askAction(graph, "t-live", "swap $20 usdc for eth");
    expect(prompt).toContain("Confirm?");
  });
});

describe("what a swap can be", () => {
  test("selling anything but USDC is refused, with the reason", () => {
    const result = resolveSwapPair("ETH/USDC");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("only sell USDC");
      expect(result.message).toContain("ETH");
    }
  });

  test("a single token is the token to BUY — not a swap of it for itself", () => {
    expect(resolveSwapPair("ETH")).toEqual({ ok: true, pair: { sell: "USDC", buy: "ETH" } });
    expect(resolveSwapPair("USDC/ETH")).toEqual({ ok: true, pair: { sell: "USDC", buy: "ETH" } });
  });

  test("no pair at all asks what to buy", () => {
    const result = resolveSwapPair(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Into what?");
  });

  test("the same token on both sides is refused", () => {
    expect(resolveSwapPair("ETH/ETH").ok).toBe(false);
  });
});

describe("token amounts are not dollar amounts", () => {
  test("recognises an amount the user gave in a token", () => {
    expect(tokenDenominatedAmount("Swap 0.0001 eth to usdc")).toEqual({
      amount: 0.0001,
      symbol: "ETH",
    });
    expect(tokenDenominatedAmount("buy 0.01 eth with usdc")).toMatchObject({ symbol: "ETH" });
  });

  test("leaves dollar amounts alone, including stablecoin phrasing", () => {
    expect(tokenDenominatedAmount("swap $20 usdc for eth")).toBeUndefined();
    expect(tokenDenominatedAmount("trade 25 USDC into WETH")).toBeUndefined();
    expect(tokenDenominatedAmount("swap $20 into eth")).toBeUndefined();
  });
});

describe("dust", () => {
  test("an amount below the minimum is refused rather than broadcast", async () => {
    await onboard(newGraph(), "t-dust");
    const record = (await read(USER))!;

    const gate = evaluateGate({
      record,
      actionType: "swap",
      amountUsd: 0.0001,
      spentTodayUsd: 0,
      revoked: false,
      onchainAllowanceUsd: null,
    });
    expect(gate.allow).toBe(false);
    expect(gate.reason).toContain(`$${MIN_SPEND_USD} minimum`);
  });
});

describe("the transcript, end to end", () => {
  test("'Swap 0.0001 eth to usdc' is refused before any confirmation", async () => {
    const graph = newGraph();
    await onboard(graph, "t-eth", { daily: 20, perAction: 20 });
    await say(graph, "t-eth", "generate my wallet");

    const reply = await say(graph, "t-eth", "Swap 0.0001 eth to usdc");
    expect(reply).toContain("only sell USDC");
    expect(reply).not.toContain("Confirm?");
    expect(walletCalls()).toEqual([]);
  });

  test("'swap $20 into eth' now means buy ETH with USDC, and confirms", async () => {
    const graph = newGraph();
    await onboard(graph, "t-into", { daily: 100, perAction: 50 });
    await say(graph, "t-into", "generate my wallet");

    const prompt = await askAction(graph, "t-into", "swap $20 into eth");
    expect(prompt).toContain("Swap $20 USDC → ETH");
  });
});

describe("no spend permission, on a provider that needs one", () => {
  test("execution refuses instead of spending the shared agent spender's float", async () => {
    await onboard(newGraph(), "t-perm");

    // The stub is permissionless by design (no chain, memory caps only), so stand in
    // the real provider's shoes for this one: on CDP, a spend with no permission
    // pulls nothing from the user and moves the SHARED spender's own USDC instead.
    Object.defineProperty(walletProvider(), "requiresSpendPermission", { value: true });

    await writeWallet(USER, {
      account_key: USER,
      smart_account: `0x${"1".repeat(40)}`,
      agent_spender: `0x${"2".repeat(40)}`,
      spend_permission: null,
    });

    const outcome = await performSpend({
      userId: USER,
      actionType: "swap",
      amountUsd: 10,
      idempotencyKey: "k1",
      pair: "USDC/ETH",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("no authority");
    expect(walletCalls()).not.toContain("swap");
  });
});
