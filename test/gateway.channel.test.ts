import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { backend } from "../memory/backend.ts";
import { appendSpend, initialize, read, type Channel } from "../memory/index.ts";
import { splitMessage } from "../src/gateway/core.ts";
import { resolveUser } from "../src/identity/index.ts";
import { mintLinkCode, redeemLinkCode } from "../src/identity/linking.ts";
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
 * Phase 11 — the channel abstraction.
 *
 * `runTurn` is the whole of Ward's gateway behaviour, written once. These drive it
 * through a fake adapter to prove that a second surface needs no second copy of the
 * conversation logic, and that what a channel controls is presentation and how a
 * confirmation is answered — never what the user is allowed to do.
 */

const TG_ACCOUNT = "700100200";
const DISCORD_ACCOUNT = "551234567890123456";

let graph: Graph;

beforeEach(async () => {
  await hermeticSetup();
  graph = newGraph();
});
afterEach(hermeticTeardown);

async function say(
  adapter: FakeAdapter,
  thread: string,
  userId: string,
  accountId: string,
  text: string,
): Promise<string> {
  return turnOn(graph, adapter, { thread, userId, accountId, text });
}

describe("runTurn on an arbitrary channel", () => {
  test("drives onboarding to a written authorization record", async () => {
    const { userId } = await resolveUser("discord", DISCORD_ACCOUNT);
    const adapter = new FakeAdapter("discord");
    const thread = "discord:c1:1";

    const first = await say(adapter, thread, userId, DISCORD_ACCOUNT, "hi");
    expect(first.length).toBeGreaterThan(0);
    expect(adapter.typingCalls).toBe(1);

    await say(adapter, thread, userId, DISCORD_ACCOUNT, "conservative");
    await say(adapter, thread, userId, DISCORD_ACCOUNT, "25");
    const done = await say(adapter, thread, userId, DISCORD_ACCOUNT, "60");

    const record = await read(userId);
    expect(record?.risk_label).toBe("conservative");
    expect(record?.standing_caps.daily_limit_usd).toBe(60);
    expect(done).toMatch(/60/);
  });

  test("a refusal reaches the channel when there is no authorization", async () => {
    const { userId } = await resolveUser("discord", DISCORD_ACCOUNT);
    await initialize(userId, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });
    await backend().forgetEntity("ward.authorization", userId);

    const adapter = new FakeAdapter("discord");
    const reply = await say(
      adapter,
      "discord:c1:1",
      userId,
      DISCORD_ACCOUNT,
      "swap $20 usdc for eth",
    );

    expect(reply).toMatch(/no authorization/i);
    expect(walletCalls()).toEqual([]); // nothing was broadcast
  });

  test("the final message is marked rendered, streamed fragments are not", async () => {
    const { userId } = await resolveUser("discord", DISCORD_ACCOUNT);
    const adapter = new FakeAdapter("discord");
    await say(adapter, "discord:c1:1", userId, DISCORD_ACCOUNT, "hi");
    expect(adapter.sent.at(-1)?.mode).toBe("rendered");
  });
});

describe("confirmations, however the channel asks", () => {
  async function onboarded(channel: Channel, accountId: string): Promise<string> {
    const { userId } = await resolveUser(channel, accountId);
    await initialize(userId, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 100,
    });
    return userId;
  }

  test("approving executes and reports the transaction", async () => {
    const userId = await onboarded("discord", DISCORD_ACCOUNT);
    const adapter = new FakeAdapter("discord", 2000, 0, [true]);

    const reply = await say(
      adapter,
      "discord:c1:1",
      userId,
      DISCORD_ACCOUNT,
      "swap $20 usdc for eth",
    );

    expect(adapter.confirms).toHaveLength(1);
    expect(adapter.confirms[0]).toMatch(/confirm/i);
    expect(reply).toMatch(/swapped/i);
    expect((await read(userId))?.spent_ledger).toHaveLength(1);
  });

  test("declining moves nothing", async () => {
    const userId = await onboarded("discord", DISCORD_ACCOUNT);
    const adapter = new FakeAdapter("discord", 2000, 0, [false]);

    const reply = await say(
      adapter,
      "discord:c1:1",
      userId,
      DISCORD_ACCOUNT,
      "swap $20 usdc for eth",
    );

    expect(reply).toMatch(/cancelled/i);
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
  });

  test("an unanswered confirmation is a refusal, not an approval", async () => {
    const userId = await onboarded("discord", DISCORD_ACCOUNT);
    // No answers queued — the button was never clicked, the message never replied to.
    const adapter = new FakeAdapter("discord", 2000, 0, []);

    const reply = await say(
      adapter,
      "discord:c1:1",
      userId,
      DISCORD_ACCOUNT,
      "swap $20 usdc for eth",
    );

    expect(reply).toMatch(/didn't get an answer/i);
    expect((await read(userId))?.spent_ledger).toHaveLength(0);
    expect(walletCalls()).toEqual([]);
  });
});

describe("the channel decides presentation, never authority", () => {
  test("each channel splits to its own limit", () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");

    const discord = splitMessage(long, 2000);
    const telegram = splitMessage(long, 4096);

    for (const chunk of discord) expect(chunk.length).toBeLessThanOrEqual(2000);
    for (const chunk of telegram) expect(chunk.length).toBeLessThanOrEqual(4096);
    expect(discord.length).toBeGreaterThan(telegram.length);
  });

  test("two linked channels share one daily cap through the same runTurn", async () => {
    // Telegram onboards with a $10/day cap, then links Discord.
    const { userId } = await resolveUser("telegram", TG_ACCOUNT);
    await initialize(userId, {
      risk_label: "moderate",
      per_action_limit_usd: 50,
      daily_limit_usd: 10,
    });
    const { code } = await mintLinkCode(userId, "telegram");
    expect((await redeemLinkCode(code, "discord", DISCORD_ACCOUNT)).ok).toBe(true);

    // $8 already spent, from wherever.
    await appendSpend(userId, {
      amount_usd: 8,
      action_type: "swap",
      tx_hash: "0xaaa",
      idempotency_key: "k1",
    });

    // Now ask from Discord for more than the $2 that remains.
    const adapter = new FakeAdapter("discord", 2000, 0, [true]);
    const reply = await say(
      adapter,
      "discord:c9:1",
      userId,
      DISCORD_ACCOUNT,
      "swap $20 usdc for eth",
    );

    // Refused on the shared ledger — a second app is not a second allowance.
    expect(reply.toLowerCase()).toMatch(/can't|cap|daily/);
    expect((await read(userId))?.spent_ledger).toHaveLength(1);
  });

  test("threads are per-channel while the record behind them is shared", async () => {
    const { userId } = await resolveUser("telegram", TG_ACCOUNT);
    const { code } = await mintLinkCode(userId, "telegram");
    await redeemLinkCode(code, "discord", DISCORD_ACCOUNT);

    // Onboard entirely from Telegram's thread.
    const tg = new FakeAdapter("telegram", 4096);
    for (const line of ["hi", "aggressive", "40", "90"]) {
      await say(tg, "telegram:1:1", userId, TG_ACCOUNT, line);
    }
    expect((await read(userId))?.standing_caps.daily_limit_usd).toBe(90);

    // A fresh Discord thread has none of that conversation, but does have the record —
    // so it does not re-onboard.
    const dc = new FakeAdapter("discord");
    const reply = await say(dc, "discord:c1:1", userId, DISCORD_ACCOUNT, "what are my limits?");
    expect(reply).toMatch(/90/);
    expect(reply).not.toMatch(/risk tolerance|conservative, moderate or aggressive/i);
  });
});
