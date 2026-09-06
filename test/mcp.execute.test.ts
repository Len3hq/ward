import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  appendRevocation,
  initialize,
  read,
  readMcpReceipt,
  writeWallet,
} from "../memory/index.ts";
import { clearChannels, registerChannel } from "../src/gateway/channels.ts";
import { mcpCommand, whoamiCommand } from "../src/identity/commands.ts";
import { link, resolveUser } from "../src/identity/index.ts";
import { executeForToken } from "../src/mcp/execute.ts";
import { tokenRef } from "../src/mcp/grants.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { issueToken, tokenAccountId } from "../src/mcp/token.ts";
import { hermeticSetup, hermeticTeardown } from "./support.ts";

/**
 * Phase 16.3 — the first path where Ward spends without asking at that moment.
 *
 * So the assertions that matter are the refusals: outside the grant's action types,
 * over its per-action limit, over its daily limit, after revocation of the grant, and
 * after revocation of the action itself. Plus the two properties the phase promises —
 * the tool does not exist without a grant, and the user is always told.
 */

const TG = "700100200";
const DISCORD = "1234567890123456789";

let userId = "";
let token = "";
let ref = "";
let told: string[] = [];

beforeEach(async () => {
  // The shared harness, and not a hand-rolled one: it deletes CDP_API_KEY_ID so the
  // stub wallet provider is selected. Without that these tests would reach the real
  // CDP API with whatever keys are in the developer's .env.
  await hermeticSetup();
  clearChannels();
  told = [];

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
  token = await issueToken(userId);
  ref = tokenRef(tokenAccountId(token));

  registerChannel("telegram", {
    async notify(_id, text) {
      told.push(text);
    },
    async adapterFor() {
      return null;
    },
  });
});

afterEach(async () => {
  clearChannels();
  await hermeticTeardown();
});

const ctx = { channel: "telegram" as const, accountId: TG };

async function grant(args: string): Promise<void> {
  const proposal = await mcpCommand(ctx, `grant ${args}`);
  const code = /\/mcp confirm ([A-Z0-9]+)/.exec(proposal)?.[1];
  if (!code) throw new Error(`grant was refused: ${proposal}`);
  await mcpCommand(ctx, `confirm ${code}`);
  told = [];
}

/** Settlement is deliberately not awaited by the tool, so give it a tick to land. */
async function settled(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5));
}

describe("the tool only exists with a grant", () => {
  async function toolNames(canExecute: boolean): Promise<string[]> {
    const server = createMcpServer(() => token, { canExecute });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  }

  test("an ungranted client sees exactly the pre-16.3 surface", async () => {
    const names = await toolNames(false);
    expect(names).not.toContain("ward_execute_action");
    expect(names.filter((n) => /execute|swap|pay|send|transfer|approve/i.test(n))).toEqual([]);
  });

  test("a granted client gets execute and receipt, and nothing else new", async () => {
    const names = await toolNames(true);
    expect(names).toContain("ward_execute_action");
    expect(names).toContain("ward_receipt");
    expect(names).toHaveLength(7);
  });
});

describe("execution refuses outside the grant", () => {
  test("an action type the grant does not cover", async () => {
    await grant(`${ref} x402 0.5 2 7`);

    const result = await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");

    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("not swap");
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });

  test("with no grant at all, nothing executes", async () => {
    const result = await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");

    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("no live execution grant");
  });

  test("a revoked grant stops execution immediately", async () => {
    await grant(`${ref} swap 20 40 7`);
    await mcpCommand(ctx, `revoke ${ref}`);

    const result = await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");

    expect(result).toMatchObject({ ok: false });
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });

  test("over the grant's per-action limit — and the refusal names the grant", async () => {
    await grant(`${ref} swap 5 40 7`);

    const result = await executeForToken(userId, tokenAccountId(token), "swap $30 usdc for eth");
    expect(result).toMatchObject({ ok: true });
    await settled();

    const record = await read(userId);
    expect(record?.spent_ledger).toHaveLength(0);
    expect(told.join("\n")).toContain("granted this client");
  });

  test("the user's own revocation still blocks a granted client", async () => {
    await grant(`${ref} swap 20 40 7`);
    await appendRevocation(userId, { action_type: "swap", reason: "paused" });

    await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    await settled();

    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });
});

describe("a spend inside the grant", () => {
  test("executes, tags the ledger with the token, and settles the receipt", async () => {
    await grant(`${ref} swap 20 40 7`);

    const result = await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    expect(result).toMatchObject({ ok: true });
    await settled();

    const record = await read(userId);
    expect(record?.spent_ledger).toHaveLength(1);
    expect(record?.spent_ledger[0]).toMatchObject({
      action_type: "swap",
      amount_usd: 10,
      via_token: tokenAccountId(token),
    });

    const receipt = await readMcpReceipt((result as { receiptId: string }).receiptId);
    expect(receipt).toMatchObject({ status: "done", amount_usd: 10 });
    expect(receipt?.tx_hash).toMatch(/^0x/);
  });

  test("the user is told, with the amount and how to revoke", async () => {
    await grant(`${ref} swap 20 40 7`);
    await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    await settled();

    expect(told).toHaveLength(1);
    expect(told[0]).toContain("without asking");
    expect(told[0]).toContain("$10.00");
    expect(told[0]).toContain(`/mcp revoke ${ref}`);
  });

  test("the grant's daily limit binds before the user's own", async () => {
    await grant(`${ref} swap 20 25 7`);

    await executeForToken(userId, tokenAccountId(token), "swap $20 usdc for eth");
    await settled();
    await executeForToken(userId, tokenAccountId(token), "swap $20 usdc for eth");
    await settled();

    const record = await read(userId);
    // $40 would be inside the user's own $100 cap; the grant is what stopped it.
    expect(record?.spent_ledger).toHaveLength(1);
    expect(told.join("\n")).toContain("you granted this client");
  });

  test("every linked human channel hears about it, and MCP does not", async () => {
    await link(userId, "discord", DISCORD, "link_code");
    const discord: string[] = [];
    registerChannel("discord", {
      async notify(_id, text) {
        discord.push(text);
      },
      async adapterFor() {
        return null;
      },
    });

    await grant(`${ref} swap 20 40 7`);
    // Granting is itself announced, so start counting from after it.
    discord.length = 0;
    await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    await settled();

    expect(told).toHaveLength(1);
    expect(discord).toHaveLength(1);
  });
});

describe("receipts", () => {
  test("belong to the token that made them", async () => {
    await grant(`${ref} swap 20 40 7`);
    const result = await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    await settled();

    const { receiptFor } = await import("../src/mcp/execute.ts");
    const id = (result as { receiptId: string }).receiptId;

    expect(await receiptFor(id, userId, tokenAccountId(token))).not.toBeNull();
    // A second token on the same principal must not read the first one's receipts.
    const other = await issueToken(userId);
    expect(await receiptFor(id, userId, tokenAccountId(other))).toBeNull();
  });
});

/**
 * Phase 16.4 — what the user can see and how they stop it. Attribution matters
 * because there is now more than one authority writing to one ledger, and the kill
 * switch matters because "revoke each grant in turn" is the wrong thing to be doing
 * when you are not yet sure what is happening.
 */
describe("seeing it and stopping it", () => {
  test("the ledger says who caused each spend", async () => {
    await grant(`${ref} swap 20 40 7`);
    await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth");
    await settled();

    const record = await read(userId);
    expect(record?.spent_ledger[0]?.via_token).toBe(tokenAccountId(token));

    const server = createMcpServer(() => token, { canExecute: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
    const result = (await client.callTool({
      name: "ward_recent_activity",
      arguments: {},
    })) as { content: Array<{ text?: string }> };
    await client.close();

    expect(result.content.map((c) => c.text ?? "").join("\n")).toContain("by this client");
  });

  test("/whoami warns about clients that can spend without asking", async () => {
    const before = await whoamiCommand(ctx);
    expect(before).not.toContain("WITHOUT asking");

    await grant(`${ref} swap 20 40 7`);

    const after = await whoamiCommand(ctx);
    expect(after).toContain("WITHOUT asking");
    expect(after).toContain(ref);
    expect(after).toContain("/mcp stop");
  });

  test("/mcp stop revokes every grant at once", async () => {
    const second = await issueToken(userId);
    const secondRef = tokenRef(tokenAccountId(second));
    await grant(`${ref} swap 20 40 7`);
    await grant(`${secondRef} x402 0.5 2 7`);

    const reply = await mcpCommand(ctx, "stop");

    expect(reply).toContain("2 grants revoked");
    expect(await mcpCommand(ctx, "grants")).toContain("No execution grants");
    expect(
      await executeForToken(userId, tokenAccountId(token), "swap $10 usdc for eth"),
    ).toMatchObject({ ok: false });
  });

  test("/mcp stop leaves the tokens themselves working", async () => {
    await grant(`${ref} swap 20 40 7`);
    await mcpCommand(ctx, "stop");

    // Still linked: it can read and propose, it just cannot act on its own.
    expect(await mcpCommand(ctx, "tokens")).toContain("read and propose only");
    const { resolveToken } = await import("../src/mcp/token.ts");
    expect(await resolveToken(token)).toBe(userId);
  });

  test("/mcp stop says so when nothing is granted", async () => {
    expect(await mcpCommand(ctx, "stop")).toContain("no live grants");
  });
});
