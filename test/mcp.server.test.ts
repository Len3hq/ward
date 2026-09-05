import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { backend } from "../memory/backend.ts";
import { appendSpend, initialize, read, readProposalQueue } from "../memory/index.ts";
import type { ChannelAdapter } from "../src/gateway/adapter.ts";
import { clearChannels, registerChannel } from "../src/gateway/channels.ts";
import { startProposalWatcher } from "../src/gateway/proposals.ts";
import { linkCommand, unlinkCommand } from "../src/identity/commands.ts";
import { accountsFor, resolveExisting, resolveUser } from "../src/identity/index.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { issueToken, resolveToken, tokenAccountId } from "../src/mcp/token.ts";
import { hermeticSetup, hermeticTeardown, newGraph, walletCalls, type Graph } from "./support.ts";

/**
 * Phase 12 — Ward as an MCP server.
 *
 * The surface exists to test the project's own claim: an MCP client holds a token,
 * not a person, so it may read and propose but must never be able to move money on
 * its own. These assert the omission as hard as the features.
 */

const TG = "700100200";

let graph: Graph;
let userId: string;
let token: string;

beforeEach(async () => {
  await hermeticSetup();
  clearChannels();
  graph = newGraph();
  ({ userId } = await resolveUser("telegram", TG));
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  token = await issueToken(userId);
});

afterEach(async () => {
  clearChannels();
  await hermeticTeardown();
});

/**
 * An MCP client wired straight to the server over an in-memory transport.
 *
 * `null` means the client presents no token at all. It cannot be `undefined`: an
 * explicit `undefined` argument would fall back to the default parameter and quietly
 * present a valid token instead.
 */
async function connect(presented: string | null = token): Promise<Client> {
  const server = createMcpServer(() => presented ?? undefined);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  return {
    isError: result.isError === true,
    text: result.content.map((c) => c.text ?? "").join("\n"),
  };
}

describe("the tool surface", () => {
  test("offers read and propose, and deliberately no way to execute", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "ward_link_status",
      "ward_propose_action",
      "ward_read_authorization",
      "ward_recent_activity",
      "ward_whoami",
    ]);

    // The point of the whole surface: nothing here spends.
    expect(names.some((n) => /execute|swap|pay|send|transfer|approve/i.test(n))).toBe(false);
    await client.close();
  });

  test("reads the live authorization record", async () => {
    await appendSpend(userId, {
      amount_usd: 12.5,
      action_type: "swap",
      tx_hash: "0xabc",
      idempotency_key: "k1",
    });

    const client = await connect();
    const { text, isError } = await call(client, "ward_read_authorization");

    expect(isError).toBe(false);
    expect(text).toContain("moderate");
    expect(text).toContain("$100");
    expect(text).toMatch(/Spent today:\s+\$12\.50/);
    expect(text).toMatch(/Remaining today:\s+\$87\.50/);
    await client.close();
  });

  test("whoami names the principal and never echoes the token back", async () => {
    const client = await connect();
    const { text } = await call(client, "ward_whoami");

    expect(text).toContain(userId);
    expect(text).toContain(`telegram:${TG}`);
    // The digest is as good as the credential for lookup — neither may be printed.
    expect(text).not.toContain(token);
    expect(text).not.toContain(tokenAccountId(token));
    await client.close();
  });
});

describe("token binding", () => {
  test("no token means every tool refuses, with instructions", async () => {
    const client = await connect(null);
    for (const name of ["ward_whoami", "ward_read_authorization", "ward_link_status"]) {
      const { text, isError } = await call(client, name);
      expect(isError).toBe(true);
      expect(text).toMatch(/\/link mcp/);
    }
    await client.close();
  });

  test("an unissued token resolves to nobody", async () => {
    expect(await resolveToken("wardmcp_totally-made-up-value-here")).toBeNull();
    expect(await resolveToken("not-even-the-right-shape")).toBeNull();

    const client = await connect("wardmcp_totally-made-up-value-here");
    const { isError, text } = await call(client, "ward_whoami");
    expect(isError).toBe(true);
    expect(text).toMatch(/revoked|not one Ward issued/i);
    await client.close();
  });

  test("/link mcp mints from a human channel, and an MCP client cannot mint its own", async () => {
    const reply = await linkCommand({ channel: "telegram", accountId: TG }, "mcp");
    const minted = reply.match(/wardmcp_[A-Za-z0-9_-]+/)?.[0];
    expect(minted).toBeDefined();
    expect(await resolveToken(minted!)).toBe(userId);
    // The reply has to be honest about what the token cannot do.
    expect(reply).toMatch(/cannot approve|can't move/i);

    const refused = await linkCommand({ channel: "mcp", accountId: "whatever" }, "mcp");
    expect(refused).toMatch(/can't mint its own/i);
  });

  test("/unlink mcp revokes every token at once, not just the newest", async () => {
    const second = await issueToken(userId);
    expect(await accountsFor(userId)).toHaveLength(3); // telegram + 2 mcp

    const reply = await unlinkCommand({ channel: "telegram", accountId: TG }, "mcp");
    expect(reply).toMatch(/revoked 2 mcp tokens/i);

    // A forgotten second token must not survive a revoke.
    expect(await resolveToken(token)).toBeNull();
    expect(await resolveToken(second)).toBeNull();
    expect(await resolveExisting("telegram", TG)).toBe(userId);
  });
});

describe("the deletion gate reaches this surface too", () => {
  test("every tool refuses once the authorization record is gone", async () => {
    await backend().forgetEntity("ward.authorization", userId);
    expect(await read(userId)).toBeNull();

    const client = await connect();

    for (const name of ["ward_read_authorization", "ward_recent_activity"]) {
      const { text, isError } = await call(client, name);
      expect(isError).toBe(true);
      expect(text).toMatch(/no authorization record/i);
    }

    // Identity still resolves — the user is known, they simply have no authority.
    const whoami = await call(client, "ward_whoami");
    expect(whoami.text).toMatch(/Authorization: NONE/);
    expect(whoami.text).toMatch(/will not move funds/i);

    const proposal = await call(client, "ward_propose_action", {
      request: "swap $20 usdc for eth",
    });
    expect(proposal.isError).toBe(true);
    expect(await readProposalQueue()).toHaveLength(0);

    await client.close();
  });
});

describe("proposing", () => {
  test("queues a proposal without moving anything", async () => {
    const client = await connect();
    const { text, isError } = await call(client, "ward_propose_action", {
      request: "swap $20 usdc for eth",
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/nothing has moved/i);

    const queue = await readProposalQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.request).toBe("swap $20 usdc for eth");
    expect(queue[0]?.ward_user_id).toBe(userId);

    // Nothing reached a wallet, and the ledger is untouched.
    expect(walletCalls()).toEqual([]);
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
    await client.close();
  });

  test("refuses to propose something that isn't a spend", async () => {
    const client = await connect();
    const { isError } = await call(client, "ward_propose_action", {
      request: "what are my limits?",
    });
    expect(isError).toBe(true);
    expect(await readProposalQueue()).toHaveLength(0);
    await client.close();
  });

  test("does not bother asking for an action the user has revoked", async () => {
    const { appendRevocation } = await import("../memory/index.ts");
    await appendRevocation(userId, { action_type: "swap", reason: "paused trading" });

    const client = await connect();
    const { text, isError } = await call(client, "ward_propose_action", {
      request: "swap $20 usdc for eth",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/revoked/i);
    expect(await readProposalQueue()).toHaveLength(0);
    await client.close();
  });
});

describe("delivery to a human channel", () => {
  /** Records what the user is shown, and answers the confirmation on cue. */
  class FakeAdapter implements ChannelAdapter {
    readonly sent: string[] = [];
    readonly confirms: string[] = [];
    readonly channel = "telegram" as const;
    readonly limit = 4096;
    readonly editThrottleMs = 0;

    constructor(private answers: Array<boolean | null> = []) {}
    async typing(): Promise<void> {}
    async send(text: string): Promise<string> {
      this.sent.push(text);
      return String(this.sent.length - 1);
    }
    async edit(handle: string, text: string): Promise<void> {
      this.sent[Number(handle)] = text;
    }
    async askConfirm(text: string): Promise<boolean | null> {
      this.confirms.push(text);
      return this.answers.shift() ?? null;
    }
  }

  function useAdapter(adapter: ChannelAdapter): void {
    registerChannel("telegram", {
      async notify() {},
      async adapterFor() {
        return adapter;
      },
    });
  }

  test("a proposal surfaces as a confirmation on the user's own channel", async () => {
    const adapter = new FakeAdapter([true]);
    useAdapter(adapter);

    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    const watcher = startProposalWatcher(graph, 60_000);
    expect(await watcher.drain()).toBe(1);
    watcher.stop();

    // The user is told where it came from before being asked anything.
    expect(adapter.sent[0]).toMatch(/MCP client asked me/i);
    expect(adapter.confirms).toHaveLength(1);
    expect(adapter.confirms[0]).toMatch(/confirm/i);

    // Approved on the human channel, so it executed — under the ordinary gate.
    expect((await read(userId))?.spent_ledger).toHaveLength(1);
    expect(await readProposalQueue()).toHaveLength(0);
  });

  test("declining on the human channel moves nothing", async () => {
    useAdapter(new FakeAdapter([false]));

    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    const watcher = startProposalWatcher(graph, 60_000);
    await watcher.drain();
    watcher.stop();

    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });

  test("an ignored proposal moves nothing — silence is never approval", async () => {
    const adapter = new FakeAdapter([]); // never answered
    useAdapter(adapter);

    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    const watcher = startProposalWatcher(graph, 60_000);
    await watcher.drain();
    watcher.stop();

    expect(adapter.confirms).toHaveLength(1);
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
    expect(walletCalls()).toEqual([]);
  });

  test("a proposal still meets the daily cap on delivery", async () => {
    await appendSpend(userId, {
      amount_usd: 95,
      action_type: "swap",
      tx_hash: "0xaaa",
      idempotency_key: "k1",
    });

    const adapter = new FakeAdapter([true]);
    useAdapter(adapter);

    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    const watcher = startProposalWatcher(graph, 60_000);
    await watcher.drain();
    watcher.stop();

    // $5 of headroom left, so $20 is refused — the MCP route bought attention,
    // not authority.
    expect((await read(userId))?.spent_ledger).toHaveLength(1);
    expect(adapter.sent.join("\n").toLowerCase()).toMatch(/can't|cap|daily|limit/);
  });

  test("a proposal is dropped if the authorization is deleted before delivery", async () => {
    const adapter = new FakeAdapter([true]);
    useAdapter(adapter);

    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    await backend().forgetEntity("ward.authorization", userId);

    const watcher = startProposalWatcher(graph, 60_000);
    expect(await watcher.drain()).toBe(0);
    watcher.stop();

    expect(adapter.confirms).toHaveLength(0);
    expect(walletCalls()).toEqual([]);
  });

  test("with no human channel running, the proposal waits rather than vanishing", async () => {
    // No channel registered at all — nobody to ask.
    const client = await connect();
    await call(client, "ward_propose_action", { request: "swap $20 usdc for eth" });
    await client.close();

    const watcher = startProposalWatcher(graph, 60_000);
    expect(await watcher.drain()).toBe(0);
    watcher.stop();

    expect(await readProposalQueue()).toHaveLength(1);
  });
});
