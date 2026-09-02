import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetBackend } from "../memory/backend.ts";
import type { WalletRecord } from "../memory/schema.ts";
import {
  appendAcpJob,
  appendRevocation,
  appendSpend,
  initialize,
  isRevoked,
  read,
  readWallet,
  spentToday,
  trustScore,
  writeWallet,
} from "../memory/store.ts";

// These exercise the domain logic against the hermetic `fs` backend; the Sibyl
// Memory MCP path has its own suite in memory.sibyl-mcp.test.ts.
const TG = 123456789;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-memory-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
});

afterEach(async () => {
  await resetBackend();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  await rm(dir, { recursive: true, force: true });
});

const onboard = () =>
  initialize(TG, { risk_label: "moderate", per_action_limit_usd: 50, daily_limit_usd: 100 });

const spend = (over: Partial<Parameters<typeof appendSpend>[1]> = {}) =>
  appendSpend(TG, {
    amount_usd: 10,
    action_type: "swap",
    tx_hash: "0xabc",
    idempotency_key: "k1",
    ...over,
  });

describe("read", () => {
  test("returns null when the file does not exist (the gate's trigger)", async () => {
    expect(await read(TG)).toBeNull();
  });

  test("rejects a non-numeric telegram id (path-traversal guard)", async () => {
    await expect(read("../evil" as unknown as number)).rejects.toThrow("invalid telegram id");
  });
});

describe("initialize", () => {
  test("writes the record once and read returns it", async () => {
    const record = await onboard();
    expect(record.risk_label).toBe("moderate");
    expect(record.standing_caps.daily_limit_usd).toBe(100);
    expect(record.spent_ledger).toEqual([]);
    expect(await read(TG)).toEqual(record);
  });

  test("throws on a second initialize", async () => {
    await onboard();
    await expect(onboard()).rejects.toThrow("already initialized");
  });

  test("rejects invalid caps", async () => {
    await expect(
      initialize(TG, { risk_label: "moderate", per_action_limit_usd: -1, daily_limit_usd: 100 }),
    ).rejects.toThrow();
  });
});

describe("appendSpend", () => {
  test("throws when there is no authorization record", async () => {
    await expect(spend()).rejects.toThrow("no authorization record");
  });

  test("appends a row and defaults ts to now", async () => {
    await onboard();
    const before = Date.now();
    const record = await spend();
    expect(record.spent_ledger).toHaveLength(1);
    const ts = Date.parse(record.spent_ledger[0]!.ts);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test("is idempotent: a repeated idempotency_key writes one entry", async () => {
    await onboard();
    await spend({ idempotency_key: "dup" });
    const record = await spend({ idempotency_key: "dup", amount_usd: 999 });
    expect(record.spent_ledger).toHaveLength(1);
    expect(record.spent_ledger[0]!.amount_usd).toBe(10);
  });

  test("serialises concurrent appends — no lost updates", async () => {
    await onboard();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => spend({ idempotency_key: `c${i}`, amount_usd: 1 })),
    );
    const record = await read(TG);
    expect(record!.spent_ledger).toHaveLength(8);
  });
});

describe("spentToday", () => {
  test("returns 0 for a missing record", async () => {
    expect(await spentToday(TG)).toBe(0);
  });

  test("sums only rows in the current UTC day", async () => {
    await onboard();
    await spend({ idempotency_key: "today-1", ts: "2026-09-05T01:00:00Z", amount_usd: 30 });
    await spend({ idempotency_key: "today-2", ts: "2026-09-05T23:59:59Z", amount_usd: 12.5 });
    await spend({ idempotency_key: "yesterday", ts: "2026-09-04T23:59:59Z", amount_usd: 100 });
    await spend({ idempotency_key: "tomorrow", ts: "2026-09-06T00:00:00Z", amount_usd: 100 });

    const now = new Date("2026-09-05T12:00:00Z");
    expect(await spentToday(TG, now)).toBe(42.5);
  });

  test("day boundary: a row at 00:00:00Z counts for that day, 23:59:59Z the day before does not", async () => {
    await onboard();
    await spend({ idempotency_key: "edge-a", ts: "2026-09-05T00:00:00Z", amount_usd: 5 });
    await spend({ idempotency_key: "edge-b", ts: "2026-09-04T23:59:59.999Z", amount_usd: 7 });
    expect(await spentToday(TG, new Date("2026-09-05T00:00:01Z"))).toBe(5);
    expect(await spentToday(TG, new Date("2026-09-04T12:00:00Z"))).toBe(7);
  });
});

describe("revocation", () => {
  test("isRevoked is false with no record and with an empty log", async () => {
    expect(await isRevoked(TG, "swap")).toBe(false);
    await onboard();
    expect(await isRevoked(TG, "swap")).toBe(false);
  });

  test("appendRevocation blocks that action type, fresh on every read", async () => {
    await onboard();
    await appendRevocation(TG, { action_type: "swap", reason: "user paused trading" });
    expect(await isRevoked(TG, "swap")).toBe(true);
    expect(await isRevoked(TG, "x402_data_purchase")).toBe(false);
  });
});

describe("acp jobs & trust", () => {
  test("trustScore is the neutral prior with no history", async () => {
    await onboard();
    expect(await trustScore(TG, "agent://acme")).toBe(0.5);
  });

  test("appended jobs raise trust for that counterparty only", async () => {
    await onboard();
    await appendAcpJob(TG, {
      counterparty_id: "agent://acme",
      job_type: "token_risk",
      outcome_summary: "flagged rug indicators, correct",
      trust_delta: 0.6,
    });
    await appendAcpJob(TG, {
      counterparty_id: "agent://acme",
      job_type: "token_risk",
      outcome_summary: "correct again",
      trust_delta: 0.6,
    });
    expect(await trustScore(TG, "agent://acme")).toBeGreaterThan(0.5);
    expect(await trustScore(TG, "agent://other")).toBe(0.5);
  });

  test("rejects a trust_delta outside [-1, 1]", async () => {
    await onboard();
    await expect(
      appendAcpJob(TG, {
        counterparty_id: "agent://acme",
        job_type: "token_risk",
        outcome_summary: "x",
        trust_delta: 2,
      }),
    ).rejects.toThrow();
  });
});

describe("wallet", () => {
  const record: WalletRecord = {
    smart_account: "0x1111111111111111111111111111111111111111",
    agent_spender: "0x2222222222222222222222222222222222222222",
    spend_permission: null,
  };

  test("readWallet is null until written, then round-trips", async () => {
    expect(await readWallet(TG)).toBeNull();
    await writeWallet(TG, record);
    expect(await readWallet(TG)).toEqual(record);
  });

  test("stores an active spend permission", async () => {
    await writeWallet(TG, {
      ...record,
      spend_permission: {
        token: "USDC",
        allowance_usd: 100,
        period_seconds: 86_400,
        granted_tx: "0xdeadbeef",
        status: "active",
      },
    });
    expect((await readWallet(TG))!.spend_permission!.status).toBe("active");
  });

  test("rejects a malformed address", async () => {
    await expect(writeWallet(TG, { ...record, smart_account: "not-an-address" })).rejects.toThrow();
  });
});

describe("authorization vs wallet independence", () => {
  test("a user can connect a wallet before onboarding caps, and vice versa", async () => {
    await writeWallet(TG, {
      smart_account: "0x1111111111111111111111111111111111111111",
      agent_spender: "0x2222222222222222222222222222222222222222",
      spend_permission: null,
    });
    expect(await read(TG)).toBeNull();
    await onboard();
    expect(await read(TG)).not.toBeNull();
    expect(await readWallet(TG)).not.toBeNull();
  });
});
