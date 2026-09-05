import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { backend } from "../memory/backend.ts";
import { read } from "../memory/store.ts";
import {
  confirmAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  say,
  USER,
  walletCalls,
} from "./support.ts";

/**
 * THE eligibility gate. Judges run exactly this: with the memory record a spend
 * works; remove the record from Sibyl Memory and the same request is refused with
 * a specific message and **no transaction is broadcast**.
 *
 * The `fs` backend runs in CI. The `sibyl-mcp` backend runs the same assertions
 * when `SIBYL_MEMORY_MCP_TEST=1` (see `memory.sibyl-mcp.test.ts`).
 */
describe("deletion gate", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("with the record, a swap executes; without it, the same swap refuses and nothing broadcasts", async () => {
    const graph = newGraph();
    await onboard(graph, "gate");

    // --- with record → succeeds ---
    const ok = await confirmAction(graph, "gate", "swap $20 usdc for eth");
    expect(ok).toMatch(/swapped \$20/i);
    expect(walletCalls()).toContain("swap");
    expect((await read(USER))?.spent_ledger).toHaveLength(1);

    const callsBefore = walletCalls().length;

    // --- remove the ward.authorization entity from Sibyl Memory ---
    await backend().forgetEntity("ward.authorization", USER);
    expect(await read(USER)).toBeNull();

    // --- same request → refused, no broadcast ---
    const refusal = await say(graph, "gate2", "swap $20 usdc for eth");
    expect(refusal).toMatch(/no authorization/i);
    expect(refusal).toMatch(/won'?t move|set me up/i);
    expect(walletCalls().length).toBe(callsBefore); // provider.swap never called again
    expect(await read(USER)).toBeNull(); // still gone
  });

  test("an x402 purchase is refused the same way once the record is gone", async () => {
    const graph = newGraph();
    await onboard(graph, "gx");
    await confirmAction(graph, "gx", "risk score on PEPE");
    const before = walletCalls().length;

    await backend().forgetEntity("ward.authorization", USER);

    const refusal = await say(graph, "gx2", "risk score on WOOF");
    expect(refusal).toMatch(/no authorization/i);
    expect(walletCalls().length).toBe(before);
  });

  test("the refusal does not leak the deleted caps", async () => {
    const graph = newGraph();
    await onboard(graph, "gl", { perAction: 77, daily: 333 });
    await backend().forgetEntity("ward.authorization", USER);

    const refusal = await say(graph, "gl2", "swap $10 usdc for eth");
    expect(refusal).not.toContain("77");
    expect(refusal).not.toContain("333");
  });
});
