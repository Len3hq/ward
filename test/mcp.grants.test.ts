import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetBackend } from "../memory/backend.ts";
import { appendSpend, initialize, read, readMcpGrant, writeWallet } from "../memory/index.ts";
import { clearChannels, registerChannel } from "../src/gateway/channels.ts";
import { mcpCommand } from "../src/identity/commands.ts";
import { resolveUser } from "../src/identity/index.ts";
import {
  MAX_GRANT_DAYS,
  confirmGrant,
  grantSpentToday,
  liveGrant,
  liveGrants,
  parseActionTypes,
  revokeGrant,
  tokenRef,
} from "../src/mcp/grants.ts";
import { issueToken, tokenAccountId } from "../src/mcp/token.ts";

/**
 * Phase 16.2 — the grant object and the commands that create it.
 *
 * The property that matters most in this phase is that **nothing is armed by
 * accident**: a grant needs an explicit second step, cannot be wider than the user's
 * own caps, and expires. What consumes a grant is 16.3; here it must exist and
 * permit nothing.
 */

const TG = "700100200";
let dir = "";
let userId = "";
let token = "";
let ref = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-grants-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
  clearChannels();

  ({ userId } = await resolveUser("telegram", TG));
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  // A grant is refused without an active on-chain permission, so every test that
  // expects to reach the *other* checks needs one.
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
});

afterEach(async () => {
  await resetBackend();
  clearChannels();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const ctx = { channel: "telegram" as const, accountId: TG };

/** Run `/mcp grant …`, pull the confirmation code out of the readback, and apply it. */
async function grant(args: string): Promise<string> {
  const proposal = await mcpCommand(ctx, `grant ${args}`);
  const code = /\/mcp confirm ([A-Z0-9]+)/.exec(proposal)?.[1];
  if (!code) return proposal;
  return mcpCommand(ctx, `confirm ${code}`);
}

describe("parsing", () => {
  test("accepts the short aliases people actually type", () => {
    expect(parseActionTypes("x402")).toEqual(["x402_data_purchase"]);
    expect(parseActionTypes("swap,acp")).toEqual(["swap", "acp_job"]);
    expect(parseActionTypes("all")?.sort()).toEqual(["acp_job", "swap", "x402_data_purchase"]);
  });

  test("refuses what it does not understand rather than guessing", () => {
    expect(parseActionTypes("everything")).toBeNull();
    expect(parseActionTypes("")).toBeNull();
    expect(parseActionTypes("x402,nonsense")).toBeNull();
  });
});

describe("granting takes two deliberate steps", () => {
  test("the proposal alone grants nothing", async () => {
    const proposal = await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`);

    expect(proposal).toContain("/mcp confirm");
    expect(await liveGrant(tokenAccountId(token))).toBeNull();
  });

  test("the readback says plainly what it is about to allow", async () => {
    const proposal = await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`);

    expect(proposal).toContain("without asking you first");
    expect(proposal).toContain("$0.5 per action");
    expect(proposal).toContain("$2 per day");
    expect(proposal).toContain("7 days");
  });

  test("confirming applies it", async () => {
    const reply = await grant(`${ref} x402 0.5 2 7`);

    expect(reply).toContain("Granted");
    const live = await liveGrant(tokenAccountId(token));
    expect(live).toMatchObject({
      action_types: ["x402_data_purchase"],
      per_action_limit_usd: 0.5,
      daily_limit_usd: 2,
    });
  });

  test("a confirmation works exactly once", async () => {
    const proposal = await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`);
    const code = /\/mcp confirm ([A-Z0-9]+)/.exec(proposal)![1]!;

    expect(await mcpCommand(ctx, `confirm ${code}`)).toContain("Granted");
    expect(await mcpCommand(ctx, `confirm ${code}`)).toContain("already been used");
  });

  test("an unknown confirmation code is refused", async () => {
    expect(await mcpCommand(ctx, "confirm ZZZZZZ")).toContain("don't know");
  });

  test("a code shown to one principal is unusable by another", async () => {
    const proposal = await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`);
    const code = /\/mcp confirm ([A-Z0-9]+)/.exec(proposal)![1]!;

    const other = await resolveUser("discord", "1234567890123456789");
    const result = await confirmGrant(code, other.userId, "discord");

    expect(result).toMatchObject({ ok: false });
    expect(await liveGrant(tokenAccountId(token))).toBeNull();
  });
});

describe("a grant needs somewhere for the money to come from", () => {
  test("refuses when there is no active on-chain spend permission", async () => {
    await writeWallet(userId, {
      account_key: userId,
      smart_account: `0x${"1".repeat(40)}`,
      agent_spender: `0x${"2".repeat(40)}`,
      spend_permission: null,
    });

    const reply = await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`);

    expect(reply).toContain("no active on-chain spend permission");
    expect(reply).not.toContain("/mcp confirm");
  });

  test("refuses when the permission has been revoked", async () => {
    await writeWallet(userId, {
      account_key: userId,
      smart_account: `0x${"1".repeat(40)}`,
      agent_spender: `0x${"2".repeat(40)}`,
      spend_permission: {
        token: "USDC",
        allowance_usd: 100,
        period_seconds: 86_400,
        granted_tx: "0xabc",
        status: "revoked",
      },
    });

    expect(await mcpCommand(ctx, `grant ${ref} x402 0.5 2 7`)).toContain(
      "no active on-chain spend permission",
    );
  });
});

describe("a grant can only narrow, never widen", () => {
  test("refuses a per-action limit above the user's own", async () => {
    const reply = await mcpCommand(ctx, `grant ${ref} x402 80 90 7`);

    expect(reply).toContain("above your own");
    expect(reply).not.toContain("/mcp confirm");
  });

  test("refuses a daily limit above the user's own", async () => {
    expect(await mcpCommand(ctx, `grant ${ref} x402 10 500 7`)).toContain("above your own");
  });

  test("refuses per-action above daily, which could never bind", async () => {
    expect(await mcpCommand(ctx, `grant ${ref} x402 5 2 7`)).toContain("can't be more than");
  });

  test("refuses zero and negative limits", async () => {
    expect(await mcpCommand(ctx, `grant ${ref} x402 0 2 7`)).toContain("greater than zero");
  });

  test(`refuses a duration beyond ${MAX_GRANT_DAYS} days — a grant is not a key`, async () => {
    expect(await mcpCommand(ctx, `grant ${ref} x402 0.5 2 365`)).toContain("between 1 and");
  });

  /** The caps may have tightened between the readback and the confirmation. */
  test("re-checks against the record as it is at confirmation time", async () => {
    const proposal = await mcpCommand(ctx, `grant ${ref} x402 40 90 7`);
    const code = /\/mcp confirm ([A-Z0-9]+)/.exec(proposal)![1]!;

    // Re-onboarding tighter caps: the record is replaced, not edited in place.
    const { backend } = await import("../memory/backend.ts");
    await backend().forgetEntity("ward.authorization", userId);
    await initialize(userId, {
      risk_label: "conservative",
      per_action_limit_usd: 1,
      daily_limit_usd: 5,
    });

    expect(await mcpCommand(ctx, `confirm ${code}`)).toContain("above your own");
    expect(await liveGrant(tokenAccountId(token))).toBeNull();
  });
});

describe("expiry and revocation", () => {
  test("an expired grant is not live", async () => {
    await grant(`${ref} x402 0.5 2 1`);
    const later = new Date(Date.now() + 2 * 86_400_000);

    expect(await liveGrant(tokenAccountId(token))).not.toBeNull();
    expect(await liveGrant(tokenAccountId(token), later)).toBeNull();
    expect(await liveGrants(userId, later)).toEqual([]);
  });

  test("revoking removes the forward entry, so a check fails closed", async () => {
    await grant(`${ref} x402 0.5 2 7`);

    expect(await revokeGrant(userId, ref, "telegram")).toBe(true);

    expect(await readMcpGrant(tokenAccountId(token))).toBeNull();
    expect(await liveGrant(tokenAccountId(token))).toBeNull();
  });

  test("revoking a grant leaves the token and the record alone", async () => {
    await grant(`${ref} x402 0.5 2 7`);
    await revokeGrant(userId, ref, "telegram");

    expect(await mcpCommand(ctx, "tokens")).toContain(ref);
    expect((await read(userId))?.standing_caps.daily_limit_usd).toBe(100);
  });

  test("revoking one that is not live says so", async () => {
    expect(await mcpCommand(ctx, `revoke ${ref}`)).toContain("No live grant");
  });
});

describe("what the user can see", () => {
  test("tokens without a grant are listed as read-and-propose only", async () => {
    expect(await mcpCommand(ctx, "tokens")).toContain("read and propose only");
  });

  test("granting is announced to every other linked account", async () => {
    const told: string[] = [];
    const { userId: same } = await resolveUser("telegram", TG);
    expect(same).toBe(userId);
    registerChannel("discord", {
      async notify(_id, text) {
        told.push(text);
      },
      async adapterFor() {
        return null;
      },
    });
    const { link } = await import("../src/identity/index.ts");
    await link(userId, "discord", "1234567890123456789", "link_code");

    await grant(`${ref} x402 0.5 2 7`);

    expect(told).toHaveLength(1);
    expect(told[0]).toContain("without asking");
    expect(told[0]).toContain(`/mcp revoke ${ref}`);
  });

  test("an MCP client cannot grant itself authority", async () => {
    const reply = await mcpCommand({ channel: "mcp", accountId: "x" }, `grant ${ref} x402 1 2 7`);
    expect(reply).toContain("can't grant itself");
  });
});

describe("the derived per-token spend", () => {
  test("counts only what this token spent, from the one shared ledger", async () => {
    const hash = tokenAccountId(token);
    await appendSpend(userId, {
      action_type: "x402_data_purchase",
      amount_usd: 0.25,
      tx_hash: "0xaaa",
      idempotency_key: "a",
      via_token: hash,
    });
    await appendSpend(userId, {
      action_type: "swap",
      amount_usd: 10,
      tx_hash: "0xbbb",
      idempotency_key: "b",
    });

    expect(await grantSpentToday(userId, hash)).toBeCloseTo(0.25);
  });
});

describe("nothing in 16.2 permits a spend", () => {
  test("a granted token still exposes no tool that executes", async () => {
    await grant(`${ref} all 1 2 7`);

    const { createMcpServer } = await import("../src/mcp/server.ts");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = createMcpServer(() => token);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /execute|swap|pay|send|transfer|approve/i.test(n))).toEqual([]);
    await client.close();
  });
});
