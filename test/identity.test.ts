import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { backend, resetBackend } from "../memory/backend.ts";
import { appendSpend, initialize, read, readWallet, spentToday } from "../memory/index.ts";
import {
  accountsFor,
  isWardUserId,
  link,
  mintWardUserId,
  parseAccountRef,
  resolveExisting,
  resolveRef,
  resolveUser,
  unlink,
} from "../src/identity/index.ts";

/**
 * Phase 9 — the identity substrate.
 *
 * The property under test is not "Ward guesses who you are" (it never does) but
 * "once told, Ward keeps one principal behind every channel account, and every
 * durable record hangs off that principal alone."
 */

const TG = "700100200";
/** A real Discord snowflake shape — a bare integer, exactly like a Telegram id. */
const SNOWFLAKE = "551234567890123456";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-identity-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
});

afterEach(async () => {
  await resetBackend();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("ward user ids", () => {
  test("are non-numeric, so a channel account can never be mistaken for one", () => {
    const id = mintWardUserId();
    expect(isWardUserId(id)).toBe(true);
    expect(id).toMatch(/^ward_[0-9A-HJKMNP-TV-Z]{26}$/);

    // The collision this exists to prevent (MULTI-CHANNEL.md §2).
    expect(isWardUserId(TG)).toBe(false);
    expect(isWardUserId(SNOWFLAKE)).toBe(false);
  });

  test("are unique across mints", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintWardUserId()));
    expect(ids.size).toBe(200);
  });
});

describe("resolveUser", () => {
  test("mints a principal on first contact and returns the same one after", async () => {
    const first = await resolveUser("telegram", TG);
    expect(first.created).toBe(true);
    expect(isWardUserId(first.userId)).toBe(true);

    const second = await resolveUser("telegram", TG);
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);
  });

  test("keeps a Discord snowflake separate from an identical Telegram id", async () => {
    const tg = await resolveUser("telegram", TG);
    const discord = await resolveUser("discord", TG); // same digits, different channel
    expect(discord.userId).not.toBe(tg.userId);
  });

  test("refuses to mint for MCP — a local process has no identity of its own", async () => {
    await expect(resolveUser("mcp", "abc123")).rejects.toThrow(/cannot mint a principal/);
    expect(await resolveExisting("mcp", "abc123")).toBeNull();
  });

  test("rejects an account id that could escape an entity name", async () => {
    await expect(resolveUser("telegram", "../evil")).rejects.toThrow();
  });
});

describe("link / unlink", () => {
  test("a second channel lands on the same authorization record", async () => {
    const { userId } = await resolveUser("telegram", TG);
    await initialize(userId, {
      risk_label: "conservative",
      per_action_limit_usd: 25,
      daily_limit_usd: 60,
    });

    await link(userId, "discord", SNOWFLAKE, "link_code");

    // What the Discord gateway would resolve on its next turn.
    const fromDiscord = await resolveExisting("discord", SNOWFLAKE);
    expect(fromDiscord).toBe(userId);
    expect((await read(fromDiscord!))?.standing_caps.daily_limit_usd).toBe(60);
  });

  test("the daily cap is one cap across channels, not one per channel", async () => {
    const { userId } = await resolveUser("telegram", TG);
    await initialize(userId, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 10,
    });
    await link(userId, "discord", SNOWFLAKE, "link_code");

    // Spend as the Telegram account.
    await appendSpend(userId, {
      amount_usd: 8,
      action_type: "swap",
      tx_hash: "0xaaa",
      idempotency_key: "k1",
    });

    // Read it back the way the Discord gateway would.
    const asDiscord = await resolveExisting("discord", SNOWFLAKE);
    expect(await spentToday(asDiscord!)).toBe(8);
  });

  test("refuses to move an account that belongs to a different principal", async () => {
    const a = await resolveUser("telegram", TG);
    const b = mintWardUserId();
    await expect(link(b, "telegram", TG, "link_code")).rejects.toThrow(/already linked/);
    expect(await resolveExisting("telegram", TG)).toBe(a.userId);
  });

  test("relinking the same account to the same principal is a no-op, not a duplicate", async () => {
    const { userId } = await resolveUser("telegram", TG);
    await link(userId, "telegram", TG, "link_code");
    expect(await accountsFor(userId)).toHaveLength(1);
  });

  test("unlink detaches one account but refuses to detach the last", async () => {
    const { userId } = await resolveUser("telegram", TG);
    await expect(unlink(userId, "telegram", TG)).rejects.toThrow(/only linked account/);

    await link(userId, "discord", SNOWFLAKE, "link_code");
    await unlink(userId, "discord", SNOWFLAKE);

    expect(await resolveExisting("discord", SNOWFLAKE)).toBeNull();
    expect(await accountsFor(userId)).toHaveLength(1);
    expect(await resolveExisting("telegram", TG)).toBe(userId);
  });

  test("unlinking leaves the authorization record alone", async () => {
    const { userId } = await resolveUser("telegram", TG);
    await initialize(userId, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });
    await link(userId, "discord", SNOWFLAKE, "link_code");
    await unlink(userId, "discord", SNOWFLAKE);
    expect(await read(userId)).not.toBeNull();
  });
});

describe("operator references", () => {
  test("parses <channel>:<account_id> and rejects anything else", () => {
    expect(parseAccountRef(`telegram:${TG}`)).toEqual({ channel: "telegram", accountId: TG });
    expect(parseAccountRef("nope:1")).toBeNull();
    expect(parseAccountRef("justtext")).toBeNull();
    expect(parseAccountRef(":1")).toBeNull();
  });

  test("resolveRef takes either a principal or a channel account", async () => {
    const { userId } = await resolveUser("telegram", TG);
    expect(await resolveRef(userId)).toBe(userId);
    expect(await resolveRef(`telegram:${TG}`)).toBe(userId);
    expect(await resolveRef("telegram:404")).toBeNull();
  });
});

describe("migration from the Telegram-only build", () => {
  const LEGACY_AUTH = {
    risk_label: "moderate" as const,
    standing_caps: { per_action_limit_usd: 50, daily_limit_usd: 100 },
    spent_ledger: [
      {
        ts: "2026-09-01T10:00:00.000Z",
        amount_usd: 12.5,
        action_type: "swap" as const,
        tx_hash: "0xlegacy",
        idempotency_key: "legacy-1",
      },
    ],
    revocation_log: [],
    acp_job_history: [],
    x402_ledger: [],
  };
  const LEGACY_WALLET = {
    smart_account: "0x1111111111111111111111111111111111111111",
    agent_spender: "0x2222222222222222222222222222222222222222",
    spend_permission: null,
  };

  async function seedLegacy(): Promise<void> {
    // The pre-Phase-9 layout: the Telegram id IS the entity name.
    await backend().putEntity("ward.authorization", TG, LEGACY_AUTH);
    await backend().putEntity("ward.wallet", TG, LEGACY_WALLET);
    await backend().setState(`ward.conversation.${TG}`, {
      summary: "prefers stablecoin pairs",
      turn_count: 4,
      updated_at: "2026-09-01T10:00:00.000Z",
    });
  }

  async function runMigration(): Promise<string> {
    const proc = Bun.spawn(["bun", "run", "scripts/migrate-identity.ts", TG], {
      env: { ...process.env, WARD_MEMORY_DIR: dir, SIBYL_MEMORY_MODE: "fs" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    await resetBackend();
    return out;
  }

  test("round-trips the record onto a new principal and drops the old key", async () => {
    await seedLegacy();
    await runMigration();

    const userId = await resolveExisting("telegram", TG);
    expect(userId).not.toBeNull();
    expect(isWardUserId(userId!)).toBe(true);

    const record = await read(userId!);
    expect(record?.standing_caps.daily_limit_usd).toBe(100);
    expect(record?.spent_ledger).toHaveLength(1);
    expect(record?.spent_ledger[0]?.tx_hash).toBe("0xlegacy");

    // The old entity name is gone, so nothing resolves through it any more.
    expect(await backend().getEntity("ward.authorization", TG)).toBeNull();
  });

  test("pins account_key to the original Telegram id so the wallet address survives", async () => {
    await seedLegacy();
    await runMigration();

    const userId = (await resolveExisting("telegram", TG))!;
    const wallet = await readWallet(userId);

    // This is the whole point: the CDP smart account is derived from account_key
    // (`ward-user-<account_key>`). Had migration rekeyed it to the new principal,
    // the user's funds and spend permission would be stranded at the old address.
    expect(wallet?.account_key).toBe(TG);
    expect(wallet?.smart_account).toBe(LEGACY_WALLET.smart_account);
  });

  test("carries the episodic summary across", async () => {
    await seedLegacy();
    await runMigration();
    const userId = (await resolveExisting("telegram", TG))!;
    const { readConversation } = await import("../memory/index.ts");
    expect((await readConversation(userId))?.summary).toBe("prefers stablecoin pairs");
  });

  test("is idempotent — a re-run finds the link and changes nothing", async () => {
    await seedLegacy();
    await runMigration();
    const first = (await resolveExisting("telegram", TG))!;

    const out = await runMigration();
    expect(out).toMatch(/already linked/);

    expect(await resolveExisting("telegram", TG)).toBe(first);
    expect((await read(first))?.spent_ledger).toHaveLength(1);
    expect(await accountsFor(first)).toHaveLength(1);
  });

  test("does nothing for a Telegram id with no legacy record", async () => {
    await runMigration();
    expect(await resolveExisting("telegram", TG)).toBeNull();
  });
});
