import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { buildGraph } from "../src/agent/graph.ts";
import { backend, resetBackend } from "../memory/backend.ts";
import { appendSpend, initialize, isRevoked, read, spentToday } from "../memory/store.ts";

/**
 * Live check against the real Sibyl Memory MCP server.
 *
 * Opt-in: needs `sibyl-memory-mcp` on PATH (`pip install 'sibyl-memory-cli[mcp]'`,
 * `sibyl init`) AND `SIBYL_MEMORY_MCP_TEST=1`. Otherwise the whole suite is
 * skipped, so `bun test` stays green on a machine without it.
 *
 * Points the server at a throwaway SQLite file so it never touches a real DB.
 */
const enabled = Bun.which("sibyl-memory-mcp") !== null && process.env.SIBYL_MEMORY_MCP_TEST === "1";

const TG = 987654321;
let dbDir: string;

beforeAll(async () => {
  dbDir = await mkdtemp(path.join(tmpdir(), "ward-sibyl-"));
  process.env.SIBYL_MEMORY_MODE = "sibyl-mcp";
  process.env.SIBYL_MEMORY_DB = path.join(dbDir, "memory.db");
});

afterAll(async () => {
  await resetBackend();
  delete process.env.SIBYL_MEMORY_MODE;
  delete process.env.SIBYL_MEMORY_DB;
  await rm(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetBackend();
});

describe.skipIf(!enabled)("Sibyl Memory MCP backend", () => {
  test("onboards and reads back through the MCP server", async () => {
    expect(await read(TG)).toBeNull();
    await initialize(TG, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });
    const record = await read(TG);
    expect(record?.standing_caps.daily_limit_usd).toBe(100);
  });

  test("appends a spend and the ledger survives a fresh connection", async () => {
    await appendSpend(TG, {
      amount_usd: 12.5,
      action_type: "x402_data_purchase",
      tx_hash: "0xfeed",
      idempotency_key: "sibyl-1",
    });
    await resetBackend(); // force a brand-new MCP connection
    expect(await spentToday(TG, new Date())).toBeGreaterThanOrEqual(12.5);
  });

  test("idempotent appendSpend across the real server", async () => {
    const before = await spentToday(TG, new Date());
    await appendSpend(TG, {
      amount_usd: 5,
      action_type: "swap",
      tx_hash: "0x1",
      idempotency_key: "sibyl-dup",
    });
    await appendSpend(TG, {
      amount_usd: 5,
      action_type: "swap",
      tx_hash: "0x1",
      idempotency_key: "sibyl-dup",
    });
    expect(await spentToday(TG, new Date())).toBeCloseTo(before + 5, 5);
  });

  test("deletion gate: forgetting the entity makes read() null again", async () => {
    expect(await read(TG)).not.toBeNull();
    await backend().forgetEntity("ward.authorization", String(TG));
    await resetBackend();
    expect(await read(TG)).toBeNull();
    expect(await isRevoked(TG, "swap")).toBe(false);
  });

  test("deletion gate at the graph level, on the real MCP backend", async () => {
    const graph = buildGraph();
    const tg = String(TG);
    const thread = { configurable: { thread_id: `mcp-gate-${Date.now()}` } };
    await initialize(TG, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });

    await backend().forgetEntity("ward.authorization", tg);
    await resetBackend();

    const result = await graph.invoke(
      { messages: [new HumanMessage("swap $20 usdc for eth")], tgId: tg },
      thread,
    );
    const reply = (result.messages.at(-1) as { content?: unknown }).content;
    expect(String(reply)).toMatch(/no authorization/i);
    expect(await read(TG)).toBeNull();
  });
});

test.skipIf(enabled)(
  "Sibyl Memory MCP suite is skipped (set SIBYL_MEMORY_MCP_TEST=1 to run)",
  () => {
    expect(enabled).toBe(false);
  },
);
