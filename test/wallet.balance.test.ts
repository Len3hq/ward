import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { tableIntent } from "../src/agent/intent.ts";
import { balanceReport } from "../src/wallet/balances.ts";
import {
  confirmAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  say,
  USER,
} from "./support.ts";

/**
 * Issue 1: "what is my balance" used to reach the conversational node, which has
 * only the authorization block in front of it — so it answered "I cannot access that
 * information" while the provider had `usdcBalanceUsd` and nobody ever called it.
 */

beforeEach(hermeticSetup);
afterEach(hermeticTeardown);

describe("balance intent", () => {
  test("a balance question is its own action, not a recital of the caps", () => {
    expect(tableIntent("What is my balance")?.action_type).toBe("balance");
    expect(tableIntent("what's my balance?")?.action_type).toBe("balance");
    expect(tableIntent("show me my holdings")?.action_type).toBe("balance");
    expect(tableIntent("how much USDC do I have")?.action_type).toBe("balance");
  });

  test("a spend still wins over the word 'balance'", () => {
    expect(tableIntent("swap my whole balance into ETH")?.action_type).toBe("swap");
    expect(tableIntent("pause everything")?.action_type).toBe("revoke");
  });

  test("questions about the caps stay read-only", () => {
    expect(tableIntent("what are my limits")?.action_type).toBe("read_only");
    expect(tableIntent("how much have I spent today")?.action_type).toBe("read_only");
  });
});

describe("balanceReport", () => {
  test("without a wallet it says so and offers the next step", async () => {
    const report = await balanceReport(USER);
    expect(report).toContain("don't have a wallet yet");
    expect(report).toContain("generate my wallet");
  });

  test("with a wallet it reports the on-chain balance, not the caps", async () => {
    const graph = newGraph();
    await onboard(graph, "t-balance");
    await say(graph, "t-balance", "generate my wallet");

    const report = await balanceReport(USER);
    expect(report).toContain("USDC: $1000.00"); // the stub provider's funded wallet
    expect(report).toContain("ETH: 0.01");
    expect(report).toContain("Spend permission: none active");
    expect(report).toMatch(/basescan\.org\/address\/0x[0-9a-fA-F]{40}/);
  });

  test("an active permission and the day's spend are part of the answer", async () => {
    const graph = newGraph();
    await onboard(graph, "t-perm", { daily: 100 });
    await say(graph, "t-perm", "generate my wallet");
    await confirmAction(graph, "t-perm", "grant a $50 daily permission");

    const report = await balanceReport(USER);
    expect(report).toContain("Spend permission: active, $50 USDC per 1 day");
    expect(report).toContain("Spent today: $0.00 of your $100 daily cap");
  });
});

describe("asking Ward for a balance", () => {
  test("the answer carries a number, and the address is copyable", async () => {
    const graph = newGraph();
    await onboard(graph, "t-ask");
    await say(graph, "t-ask", "generate my wallet");

    const reply = await say(graph, "t-ask", "What is my balance");
    expect(reply).toContain("USDC: $1000.00");
    expect(reply).not.toContain("cannot");
    // Backticks are what `gateway/format.ts` turns into each channel's copyable text.
    expect(reply).toMatch(/`0x[0-9a-fA-F]{40}`/);
  });

  test("with no authorization record at all, nothing is disclosed", async () => {
    const graph = newGraph();
    const reply = await say(graph, "t-none", "what is my balance");
    expect(reply).toContain("no authorization on file");
  });
});
