import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { BASE_SYSTEM } from "../src/agent/prompts.ts";
import { APPROVAL_REQUIRED, boundTools } from "../src/agent/tools.ts";
import {
  confirmAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  USER,
} from "./support.ts";

/**
 * Issue 2: the conversational node was frozen at Phase 2 while the rest of the repo
 * reached Phase 16. It held one read-only tool and a prompt of pure prohibitions, so
 * it answered "I don't have information on that" to questions the running process
 * could answer exactly — which x402 endpoints exist, how to link Discord, what has
 * been spent.
 *
 * These tests pin the two halves of the fix: the model can SEE the capabilities
 * (tools), and it is TOLD they exist (prompt). Neither half widens what it may do —
 * the invariant at the bottom is that none of it can spend.
 */

/**
 * `boundTools` returns tools with different input schemas, so the array's element
 * type is a union whose `invoke` signatures do not unify. These tests only ever call
 * them with no arguments, so a structural view is enough and keeps `tsc` honest.
 */
type ReadOnlyTool = { name: string; invoke: (input: Record<string, never>) => Promise<unknown> };

const tools = (): ReadOnlyTool[] => boundTools(USER) as unknown as ReadOnlyTool[];

const tool = (name: string): ReadOnlyTool => {
  const found = tools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool named ${name}`);
  return found;
};

beforeEach(hermeticSetup);
afterEach(hermeticTeardown);

describe("discover_x402_endpoints", () => {
  test("names what is for sale and what it costs", async () => {
    const out = (await tool("discover_x402_endpoints").invoke({})) as string;

    expect(out).toContain("Token Risk Score");
    expect(out).toContain("Whale Flows");
    expect(out).toContain("$0.05");
    // The question that started this: "are there x402 endpoints I can test".
    expect(out).not.toMatch(/don'?t have information|no information/i);
  });

  test("the endpoint URL is withheld — the model never needs it", async () => {
    const out = (await tool("discover_x402_endpoints").invoke({})) as string;

    expect(out).not.toContain("https://");
    expect(out).not.toContain("x402.elizaos.ai");
  });

  test("catalogue text is wrapped as data, not instruction", async () => {
    const out = (await tool("discover_x402_endpoints").invoke({})) as string;
    expect(out).toContain('<untrusted_data source="ward:x402-catalog">');
  });
});

describe("recent_activity", () => {
  test("with no authorization record it discloses nothing", async () => {
    const out = (await tool("recent_activity").invoke({})) as string;
    expect(out).toContain("No authorization record");
  });

  test("a fresh user is told the ledgers are empty, not given a refusal", async () => {
    await onboard(newGraph(), "cap-empty");

    const out = (await tool("recent_activity").invoke({})) as string;
    expect(out).toContain("Spends: none yet");
    expect(out).toContain("x402 purchases: none yet");
    expect(out).toContain("ACP jobs: none yet");
  });

  test("a confirmed spend shows up, attributed to the user", async () => {
    const graph = newGraph();
    await onboard(graph, "cap-spend");
    await confirmAction(graph, "cap-spend", "swap $20 usdc for eth");

    const out = (await tool("recent_activity").invoke({})) as string;
    expect(out).toContain("$20");
    expect(out).toContain("swap");
    expect(out).toContain("by you"); // vs. "by client …" for an MCP grant's spend
  });

  test("an x402 purchase lands in its own ledger", async () => {
    const graph = newGraph();
    await onboard(graph, "cap-x402");
    await confirmAction(graph, "cap-x402", "risk score on PEPE");

    const out = (await tool("recent_activity").invoke({})) as string;
    expect(out).toMatch(/x402 purchases:\n\s+\d{4}-/);
    expect(out).toContain("ok");
  });
});

describe("the system prompt tells the model what Ward can do", () => {
  test("it names each capability the user asked about and got refused on", () => {
    expect(BASE_SYSTEM).toContain("x402");
    expect(BASE_SYSTEM).toContain("discover_x402_endpoints");
    expect(BASE_SYSTEM).toContain("/link_discord");
    // The model has to be able to name the command that connects a coding client.
    expect(BASE_SYSTEM).toContain("/link_mcp");
    expect(BASE_SYSTEM).toContain("/mcp");
    expect(BASE_SYSTEM).toContain("Virtuals ACP");
    expect(BASE_SYSTEM).toContain("read_wallet_balance");
  });

  test("it quotes the phrasing the intent table actually matches", () => {
    // If these drift, the model hands users a phrase that routes nowhere.
    for (const phrase of [
      "generate my wallet",
      "grant a $50 daily permission",
      "hire an agent to assess PEPE",
    ]) {
      expect(BASE_SYSTEM).toContain(phrase);
    }
  });

  test("it permits general knowledge instead of refusing outright", () => {
    expect(BASE_SYSTEM).toMatch(/general crypto knowledge is fine/i);
    expect(BASE_SYSTEM).toMatch(/never reply with a bare refusal/i);
  });
});

describe("the invariant: none of this can spend", () => {
  test("no bound tool is named like an action that moves money", () => {
    for (const t of tools()) {
      expect(t.name).not.toMatch(/execute|swap|pay|send|transfer|approve|grant|revoke/);
    }
  });

  test("no tool requires the HITL approval interrupt, because none spends", () => {
    expect(APPROVAL_REQUIRED.size).toBe(0);
  });

  test("every bound tool is read-only and leaves the ledger untouched", async () => {
    const graph = newGraph();
    await onboard(graph, "cap-ro");

    for (const t of tools()) {
      await t.invoke({});
    }

    const out = (await tool("recent_activity").invoke({})) as string;
    expect(out).toContain("Spends: none yet");
  });
});
