import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isRevoked } from "../memory/store.ts";
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
 * A revocation must take effect *immediately* — the next action in the SAME
 * session is refused, not just at the next session start. `isRevoked` reads the
 * `revocation_log` fresh on every action.
 */
describe("mid-session revocation", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("pausing swaps mid-session blocks the very next swap in that session", async () => {
    const graph = newGraph();
    await onboard(graph, "rev");

    expect(await confirmAction(graph, "rev", "swap $10 usdc for eth")).toMatch(/swapped/i);
    const callsAfterFirst = walletCalls().length;

    const paused = await say(graph, "rev", "pause swaps");
    expect(paused).toMatch(/paused swap/i);
    expect(await isRevoked(TG, "swap")).toBe(true);

    const blocked = await say(graph, "rev", "swap $10 usdc for eth");
    expect(blocked).toMatch(/paused|won'?t/i);
    expect(walletCalls().length).toBe(callsAfterFirst); // no second swap broadcast
  });

  test("pausing one action type leaves the others working", async () => {
    const graph = newGraph();
    await onboard(graph, "rev2");

    await say(graph, "rev2", "pause swaps");
    expect(await isRevoked(TG, "swap")).toBe(true);
    expect(await isRevoked(TG, "x402_data_purchase")).toBe(false);

    // an x402 purchase still goes through
    expect(await confirmAction(graph, "rev2", "risk score on PEPE")).toMatch(/paid \$/i);
  });

  test("a broad revoke pauses every spend action type", async () => {
    const graph = newGraph();
    await onboard(graph, "rev3");

    const reply = await say(graph, "rev3", "revoke everything, I'm done for the day");
    expect(reply).toMatch(/paused every spend/i);

    for (const action of ["swap", "x402_data_purchase", "acp_job"] as const) {
      expect(await isRevoked(TG, action)).toBe(true);
    }
    expect(await say(graph, "rev3", "swap $5 usdc for eth")).toMatch(/paused|won'?t/i);
  });
});
