import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { read, spentToday } from "../memory/store.ts";
import {
  askAction,
  confirmAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  say,
  TG,
  walletCalls,
} from "./support.ts";

/**
 * The daily cap is enforced by summing the `spent_ledger` for the current UTC day
 * across *every* action type — one number, one cap.
 */
describe("daily cap enforcement", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("swap + x402 spend against the same cap; the next action of either type is blocked at the cap", async () => {
    const graph = newGraph();
    await onboard(graph, "cap", { perAction: 50, daily: 100 });

    expect(await confirmAction(graph, "cap", "swap $50 usdc for eth")).toMatch(/swapped/i);
    expect(await confirmAction(graph, "cap", "swap $45 usdc for eth")).toMatch(/swapped/i);
    expect(await spentToday(TG)).toBeCloseTo(95, 5);

    const callsBefore = walletCalls().length;

    // a $10 swap would breach the $100 cap → blocked, nothing broadcast
    expect(await say(graph, "cap", "swap $10 usdc for eth")).toMatch(/daily cap|exceed/i);
    expect(walletCalls().length).toBe(callsBefore);

    // a $0.05 x402 purchase still fits under the ~$5 of headroom
    expect(await askAction(graph, "cap", "smart money positioning on ETH")).toMatch(/confirm/i);

    const record = await read(TG);
    expect(record?.spent_ledger.reduce((s, r) => s + r.amount_usd, 0)).toBeCloseTo(95, 5);
  });

  test("a cheap purchase still fits under the remaining headroom", async () => {
    const graph = newGraph();
    await onboard(graph, "cap2", { perAction: 50, daily: 100 });
    await confirmAction(graph, "cap2", "swap $50 usdc for eth");
    await confirmAction(graph, "cap2", "swap $49 usdc for eth");
    // ~$1 left — a $0.05 token-risk purchase still executes
    expect(await confirmAction(graph, "cap2", "risk score on PEPE")).toMatch(/paid \$0\.05/i);
  });

  test("the per-action limit blocks before the daily cap is even touched", async () => {
    const graph = newGraph();
    await onboard(graph, "cap3", { perAction: 20, daily: 500 });
    const reply = await say(graph, "cap3", "swap $100 usdc for eth");
    expect(reply).toMatch(/per-action limit/i);
    expect(await spentToday(TG)).toBe(0);
  });
});
