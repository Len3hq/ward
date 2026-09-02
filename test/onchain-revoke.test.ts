import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { read, readWallet, writeWallet } from "../memory/store.ts";
import {
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
 * The two-limit design: revoking the on-chain Spend Permission blocks the next
 * spend **even with the Sibyl Memory record fully intact**. Memory is the agent's
 * policy layer; the on-chain permission is the hard outer bound the user controls
 * directly.
 */
describe("on-chain spend-permission revocation", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("a swap works with an active permission, then refuses once it is revoked on-chain", async () => {
    const graph = newGraph();
    await onboard(graph, "oc");
    await say(graph, "oc", "connect my wallet");
    await say(graph, "oc", "grant a $100 daily permission");

    expect(await confirmAction(graph, "oc", "swap $20 usdc for eth")).toMatch(/swapped/i);
    const callsBefore = walletCalls().length;

    // revoke ONLY the on-chain permission record — leave revocation_log clean
    const wallet = await readWallet(TG);
    await writeWallet(TG, {
      ...wallet!,
      spend_permission: { ...wallet!.spend_permission!, status: "revoked" },
    });

    const blocked = await say(graph, "oc", "swap $20 usdc for eth");
    expect(blocked).toMatch(/revoked|grant a new one/i);
    expect(walletCalls().length).toBe(callsBefore); // no swap broadcast

    // memory is untouched
    const record = await read(TG);
    expect(record).not.toBeNull();
    expect(record?.revocation_log).toHaveLength(0);
    expect(record?.standing_caps.daily_limit_usd).toBe(100);
  });

  test("granting a fresh permission unblocks it again", async () => {
    const graph = newGraph();
    await onboard(graph, "oc2");
    await say(graph, "oc2", "connect my wallet");
    await say(graph, "oc2", "grant a $100 daily permission");

    const wallet = await readWallet(TG);
    await writeWallet(TG, {
      ...wallet!,
      spend_permission: { ...wallet!.spend_permission!, status: "revoked" },
    });
    expect(await say(graph, "oc2", "swap $10 usdc for eth")).toMatch(/revoked/i);

    await say(graph, "oc2", "grant a $100 daily permission");
    expect(await confirmAction(graph, "oc2", "swap $10 usdc for eth")).toMatch(/swapped/i);
  });
});
