import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { read } from "../memory/store.ts";
import { HELP, welcome } from "../src/gateway/help.ts";
import { BASE_SYSTEM } from "../src/agent/prompts.ts";
import { parseActionTypes } from "../src/mcp/grants.ts";
import {
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  say,
  USER,
  walletCalls,
} from "./support.ts";

/**
 * Production default: swap and USDC transfer ("send") are switched off
 * (`src/agent/transfers.ts`). `hermeticSetup` turns them on for the gate / cap
 * suites, so this file turns them back off to assert the shipped behaviour.
 */
describe("swap and send are off by default", () => {
  beforeEach(async () => {
    await hermeticSetup();
    delete process.env.WARD_TRANSFERS_ENABLED;
  });
  afterEach(hermeticTeardown);

  test("a swap request is declined, with no confirmation and nothing moved", async () => {
    const graph = newGraph();
    await onboard(graph, "t1", { perAction: 50, daily: 100 });

    const before = walletCalls().length;
    const reply = await say(graph, "t1", "swap $20 usdc for eth");

    expect(reply).toMatch(/can't move tokens/i);
    expect(reply).not.toMatch(/confirm/i);
    expect(walletCalls().length).toBe(before);
    expect((await read(USER))?.spent_ledger ?? []).toHaveLength(0);
  });

  test("a send to an address is declined the same way", async () => {
    const graph = newGraph();
    await onboard(graph, "t2", { perAction: 50, daily: 100 });

    const reply = await say(graph, "t2", `send $10 to 0x${"0".repeat(40)}`);
    expect(reply).toMatch(/can't move tokens/i);
    expect(walletCalls()).toHaveLength(0);
  });

  test("the phrasing is still recognised — the decline is specific, not conversational", async () => {
    const graph = newGraph();
    await onboard(graph, "t3");
    // A genuinely unknown request would reach the conversational node; this one
    // names on-chain data and hiring an agent, which only the refuse node does.
    const reply = await say(graph, "t3", "swap $5 usdc for eth");
    expect(reply).toMatch(/on-chain data/i);
    expect(reply).toMatch(/hire another agent/i);
  });

  test("neither appears in the user-facing copy", () => {
    // welcome + help are what a user reads. (BASE_SYSTEM still names swap/send — it
    // has to tell the model to decline them — so it is deliberately not checked.)
    for (const text of [welcome("telegram"), welcome("discord"), HELP]) {
      expect(text).not.toMatch(/\bswap\b/i);
      expect(text).not.toMatch(/send \$?\d+ to 0x/i);
    }
  });

  test("BASE_SYSTEM tells the model to decline a swap rather than attempt one", () => {
    expect(BASE_SYSTEM).toMatch(/do NOT swap or send/i);
  });

  test("an MCP client cannot be granted swap or send", () => {
    expect(parseActionTypes("swap")).toBeNull();
    expect(parseActionTypes("send")).toBeNull();
    expect(parseActionTypes("all")?.sort()).toEqual(["acp_job", "x402_data_purchase"]);
  });
});
