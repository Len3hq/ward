import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { backend } from "../memory/backend.ts";
import { initialize, read, readProposalQueue } from "../memory/index.ts";
import { resolveUser } from "../src/identity/index.ts";
import { mintLinkCode, redeemLinkCode } from "../src/identity/linking.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { issueToken } from "../src/mcp/token.ts";
import {
  FakeAdapter,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  turnOn,
  walletCalls,
  type Graph,
} from "./support.ts";

/**
 * The three cross-channel properties, as first-class proofs.
 *
 * A second app is not a second allowance. These are the assertions behind that
 * claim, and each one is also a demo beat:
 *
 *   1. One daily cap, shared — spend on Telegram, be refused on Discord.
 *   2. Revocation is instant everywhere — revoke on Discord, refused on Telegram.
 *   3. The deletion gate crosses channels — delete the record, all three refuse.
 *
 * Every one drives the real surfaces: `runTurn` through a channel adapter for
 * Telegram and Discord, and a live MCP client over an in-memory transport. The gate
 * gets *stronger* as surfaces are added, never weaker, because there is only ever
 * one authorization record behind all of them.
 *
 * See `MULTI-CHANNEL.md` §4.
 */

const TG = "700100200";
const DISCORD = "551234567890123456";

interface Surfaces {
  userId: string;
  graph: Graph;
  tg: FakeAdapter;
  dc: FakeAdapter;
  mcp: Client;
}

/** One user, onboarded on Telegram, with Discord and an MCP client linked to it. */
async function linkedUser(dailyCap = 100): Promise<Surfaces> {
  const graph = newGraph();
  const { userId } = await resolveUser("telegram", TG);
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: dailyCap,
  });

  // Discord joins the way a real user would: a code minted in the Telegram DM.
  const { code } = await mintLinkCode(userId, "telegram");
  const redeemed = await redeemLinkCode(code, "discord", DISCORD);
  expect(redeemed.ok).toBe(true);

  // And an MCP client, bound by a token minted on a human channel.
  const token = await issueToken(userId);
  const server = createMcpServer(() => token);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([mcp.connect(clientSide), server.connect(serverSide)]);

  return {
    userId,
    graph,
    tg: new FakeAdapter("telegram", 4096),
    dc: new FakeAdapter("discord", 2000),
    mcp,
  };
}

async function onTelegram(s: Surfaces, text: string, thread = "telegram:1:1"): Promise<string> {
  return turnOn(s.graph, s.tg, { thread, userId: s.userId, accountId: TG, text });
}

async function onDiscord(s: Surfaces, text: string, thread = "discord:c1:1"): Promise<string> {
  return turnOn(s.graph, s.dc, { thread, userId: s.userId, accountId: DISCORD, text });
}

async function onMcp(s: Surfaces, name: string, args: Record<string, unknown> = {}) {
  const result = (await s.mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text ?? "").join("\n"),
  };
}

beforeEach(hermeticSetup);
afterEach(hermeticTeardown);

describe("one daily cap, not one per channel", () => {
  test("spending on Telegram reduces what Discord may do", async () => {
    const s = await linkedUser(10);

    // $8 of a $10 cap, approved on Telegram.
    s.tg.willAnswer(true);
    const spent = await onTelegram(s, "swap $8 usdc for eth");
    expect(spent).toMatch(/swapped \$8/i);
    expect((await read(s.userId))?.spent_ledger).toHaveLength(1);

    // The same user asks Discord for $9 — more than the $2 left.
    const callsBefore = walletCalls().length;
    s.dc.willAnswer(true);
    const refused = await onDiscord(s, "swap $9 usdc for eth");

    expect(refused.toLowerCase()).toMatch(/can't|cap|daily|limit/);
    expect((await read(s.userId))?.spent_ledger).toHaveLength(1); // still just the one
    expect(walletCalls().length).toBe(callsBefore); // nothing broadcast
  });

  test("the MCP surface reads the same reduced headroom", async () => {
    const s = await linkedUser(100);

    s.tg.willAnswer(true);
    await onTelegram(s, "swap $30 usdc for eth");

    const { text } = await onMcp(s, "ward_read_authorization");
    expect(text).toMatch(/Spent today:\s+\$30\.00/);
    expect(text).toMatch(/Remaining today:\s+\$70\.00/);
    await s.mcp.close();
  });

  test("both channels quote the same remaining budget back to the user", async () => {
    const s = await linkedUser(50);

    s.tg.willAnswer(true);
    await onTelegram(s, "swap $20 usdc for eth");

    // Ask each surface to confirm something; both should cite $30 of headroom.
    s.tg.willAnswer(false);
    await onTelegram(s, "swap $5 usdc for eth", "telegram:1:2");
    s.dc.willAnswer(false);
    await onDiscord(s, "swap $5 usdc for eth");

    expect(s.tg.confirms.join(" ")).toContain("30.00");
    expect(s.dc.confirms.join(" ")).toContain("30.00");
    await s.mcp.close();
  });
});

describe("revocation crosses channels instantly", () => {
  test("revoking swaps on Discord refuses the next Telegram swap", async () => {
    const s = await linkedUser();

    // Prove swaps work first, so the refusal afterwards means something.
    s.tg.willAnswer(true);
    expect(await onTelegram(s, "swap $10 usdc for eth")).toMatch(/swapped/i);
    const callsBefore = walletCalls().length;

    // The user pauses swaps from Discord.
    const paused = await onDiscord(s, "stop swapping");
    expect(paused.toLowerCase()).toMatch(/paused|revok/);
    expect((await read(s.userId))?.revocation_log.some((r) => r.action_type === "swap")).toBe(true);

    // Telegram, mid-session, on a thread that never saw the revocation.
    s.tg.willAnswer(true);
    const refused = await onTelegram(s, "swap $10 usdc for eth", "telegram:1:9");

    expect(refused.toLowerCase()).toMatch(/revok|paused|can't/);
    expect((await read(s.userId))?.spent_ledger).toHaveLength(1);
    expect(walletCalls().length).toBe(callsBefore);
    await s.mcp.close();
  });

  test("the MCP surface will not even propose a revoked action", async () => {
    const s = await linkedUser();
    await onDiscord(s, "stop swapping");

    const { isError, text } = await onMcp(s, "ward_propose_action", {
      request: "swap $10 usdc for eth",
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/revoked/i);
    expect(await readProposalQueue()).toHaveLength(0);
    await s.mcp.close();
  });

  test("a revocation raised on one channel is visible from the others", async () => {
    const s = await linkedUser();
    await onTelegram(s, "pause swapping");

    const { text } = await onMcp(s, "ward_read_authorization");
    expect(text).toMatch(/Revocations:\s+swap \(paused\)/);
    await s.mcp.close();
  });
});

describe("the deletion gate crosses channels", () => {
  test("deleting the record refuses on Telegram, Discord and MCP alike", async () => {
    const s = await linkedUser();

    // Working on every surface, before.
    s.tg.willAnswer(true);
    expect(await onTelegram(s, "swap $10 usdc for eth")).toMatch(/swapped/i);
    expect((await onMcp(s, "ward_read_authorization")).isError).toBe(false);
    const callsBefore = walletCalls().length;

    // The judges' deletion: one entity, out of Sibyl Memory.
    await backend().forgetEntity("ward.authorization", s.userId);
    expect(await read(s.userId)).toBeNull();

    // Telegram refuses.
    s.tg.willAnswer(true);
    const tg = await onTelegram(s, "swap $10 usdc for eth", "telegram:1:9");
    expect(tg).toMatch(/no authorization/i);

    // Discord refuses, with the same reason.
    s.dc.willAnswer(true);
    const dc = await onDiscord(s, "swap $10 usdc for eth");
    expect(dc).toMatch(/no authorization/i);

    // MCP refuses, and cannot queue a proposal to work around it.
    const mcpRead = await onMcp(s, "ward_read_authorization");
    expect(mcpRead.isError).toBe(true);
    expect(mcpRead.text).toMatch(/no authorization record/i);

    const proposal = await onMcp(s, "ward_propose_action", { request: "swap $10 usdc for eth" });
    expect(proposal.isError).toBe(true);
    expect(await readProposalQueue()).toHaveLength(0);

    // Nothing was broadcast from any of them.
    expect(walletCalls().length).toBe(callsBefore);
    await s.mcp.close();
  });

  test("the links survive deletion — the user is still known, just not authorized", async () => {
    const s = await linkedUser();
    await backend().forgetEntity("ward.authorization", s.userId);

    // Identity is a separate entity from authority, and only authority was deleted.
    const { text } = await onMcp(s, "ward_whoami");
    expect(text).toContain(s.userId);
    expect(text).toContain(`telegram:${TG}`);
    expect(text).toContain(`discord:${DISCORD}`);
    expect(text).toMatch(/Authorization: NONE/);
    await s.mcp.close();
  });

  test("no channel's refusal leaks the deleted caps", async () => {
    const s = await linkedUser(333);
    await backend().forgetEntity("ward.authorization", s.userId);

    const tg = await onTelegram(s, "swap $10 usdc for eth", "telegram:1:9");
    const dc = await onDiscord(s, "swap $10 usdc for eth");
    const mcp = await onMcp(s, "ward_read_authorization");

    for (const reply of [tg, dc, mcp.text]) {
      expect(reply).not.toContain("333");
    }
    await s.mcp.close();
  });
});
