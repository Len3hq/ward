import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetBackend } from "../memory/backend.ts";
import { readConversation } from "../memory/store.ts";
import { maybeSummarize } from "../src/agent/summary.ts";

const USER = "ward_01J9XQ4M7BZK3TVWXY0123456D";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-sum-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  delete process.env.OPENAI_API_KEY;
  await resetBackend();
});

afterEach(async () => {
  await resetBackend();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  await rm(dir, { recursive: true, force: true });
});

function turns(...texts: string[]) {
  return texts.map((t) => new HumanMessage(t));
}

describe("maybeSummarize (episodic conversation memory)", () => {
  test("does nothing before the threshold", async () => {
    await maybeSummarize(USER, turns("hi", "what can you do"));
    expect(await readConversation(USER)).toBeNull();
  });

  test("writes a HOT-state summary at the threshold and accumulates", async () => {
    await maybeSummarize(
      USER,
      turns("I mostly hold ETH and USDC", "watching PEPE", "set a $50 cap", "swap $20 to eth"),
    );
    const first = await readConversation(USER);
    expect(first).not.toBeNull();
    expect(first?.turn_count).toBe(4);
    expect(first?.summary.toLowerCase()).toContain("pepe");

    await maybeSummarize(
      USER,
      turns(
        "I mostly hold ETH and USDC",
        "watching PEPE",
        "set a $50 cap",
        "swap $20 to eth",
        "also interested in AERO",
        "what's my balance",
        "revoke swaps",
        "actually resume",
      ),
    );
    const second = await readConversation(USER);
    expect(second?.turn_count).toBe(8);
    expect(second?.updated_at).not.toBe(first?.updated_at);
  });
});
