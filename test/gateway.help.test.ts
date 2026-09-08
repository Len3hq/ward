import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { Telegraf } from "telegraf";

import { type IntentAction, parseIntent } from "../src/agent/intent.ts";

import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
  HELP,
  WELCOME,
} from "../src/gateway/help.ts";
import { publishProfile } from "../src/telegram/gateway.ts";

/**
 * The profile is the only part of Ward that fails *silently* when it is wrong.
 *
 * Telegram rejects an over-long description or a malformed command name with an API
 * error and then simply carries on serving the old, empty profile — so a typo here
 * costs the whole feature and nothing in the logs says the bot is anonymous again.
 * These are the limits from the Bot API, asserted rather than trusted.
 */

/** Telegram counts characters, not UTF-16 units, and the copy contains em dashes. */
const chars = (s: string): number => [...s].length;

describe("what Telegram will actually accept", () => {
  test("the pre-Start description fits", () => {
    expect(chars(BOT_DESCRIPTION)).toBeLessThanOrEqual(512);
    expect(chars(BOT_DESCRIPTION)).toBeGreaterThan(0);
  });

  test("the profile-page description fits", () => {
    expect(chars(BOT_SHORT_DESCRIPTION)).toBeLessThanOrEqual(120);
    expect(chars(BOT_SHORT_DESCRIPTION)).toBeGreaterThan(0);
  });

  test("every command name is one Telegram will register", () => {
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(chars(description)).toBeLessThanOrEqual(256);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  test("help and welcome fit in one message", () => {
    expect(chars(HELP)).toBeLessThanOrEqual(4096);
    expect(chars(WELCOME)).toBeLessThanOrEqual(4096);
  });
});

/**
 * Autocompleting a command that nothing handles is worse than not advertising it:
 * the user types it, Telegram offered it, and Ward says nothing at all.
 */
test("every advertised command is actually wired up", () => {
  const source = readFileSync("src/telegram/gateway.ts", "utf8");
  for (const { command } of BOT_COMMANDS) {
    // Whitespace-tolerant: prettier wraps the longer registrations across lines.
    const registered =
      new RegExp(String.raw`bot\.command\(\s*"${command}"`).test(source) ||
      (command === "help" && source.includes("bot.help("));
    expect(registered, `/${command} is advertised but not registered`).toBe(true);
  }
});

/**
 * Cosmetic, and it runs on the startup path. A profile field Telegram refuses must
 * cost that field and nothing else — never the bot coming up.
 */
test("a rejected field does not stop the bot starting", async () => {
  const calls: string[] = [];
  const failing = {
    telegram: {
      setMyCommands: () => {
        calls.push("commands");
        return Promise.reject(new Error("Bad Request: too many commands"));
      },
      setMyDescription: () => {
        calls.push("description");
        return Promise.reject(new Error("Bad Request: description is too long"));
      },
      setMyShortDescription: () => {
        calls.push("short");
        return Promise.resolve(true);
      },
    },
  } as unknown as Telegraf;

  await expect(publishProfile(failing)).resolves.toBeUndefined();
  // All three attempted: one failure must not swallow the fields after it.
  expect(calls).toEqual(["commands", "description", "short"]);
});

test("the help leads with what Ward does, not with account chores", () => {
  const capabilities = HELP.indexOf("What I can do");
  const chores = HELP.indexOf("Account");
  expect(capabilities).toBeGreaterThanOrEqual(0);
  expect(chores).toBeGreaterThan(capabilities);

  // The three things nobody knew Ward could do.
  expect(HELP).toContain("risk score");
  expect(HELP).toContain("hire an agent");
  expect(HELP).toContain("what data can I buy?");
  // Written for someone who has never heard the acronym.
  expect(HELP).toContain("Claude Code or Cursor");
});

/**
 * The help now quotes the exact sentence that starts each capability, which makes it
 * a promise: change the intent table and these stop working, silently, while the bot
 * carries on advertising them. Cheaper to fail here.
 */
describe("the phrases the help promises", () => {
  /** `[what a user types, the action it must start, what the help shows]`. */
  const promised: Array<[string, IntentAction, string]> = [
    ["what's the risk score for PEPE", "x402_data_purchase", "risk score for PEPE"],
    ["hire an agent to assess AERO", "acp_job", "hire an agent to assess AERO"],
    ["swap $20 of USDC into ETH", "swap", "swap $20 of USDC into ETH"],
    // The help shows an elided address, so only the leading words are quoted.
    ["send $10 to 0x4200000000000000000000000000000000000006", "send", "send $10 to 0x"],
    ["generate my wallet", "generate_wallet", "generate my wallet"],
    ["grant a $50 daily permission", "grant_permission", "grant a $50 daily permission"],
    ["pause swaps", "revoke", "pause swaps"],
    ["revoke my permission", "revoke", "revoke my permission"],
    ["what's my balance?", "balance", "what's my balance?"],
  ];

  for (const [phrase, action, shown] of promised) {
    test(`"${phrase}" still starts a ${action}`, async () => {
      expect(HELP).toContain(shown);
      expect((await parseIntent(phrase)).action_type).toBe(action);
    });
  }

  /** Asking what is for sale is a question, not a purchase — it must never spend. */
  test('"what data can I buy?" asks, it does not buy', async () => {
    expect((await parseIntent("what data can I buy?")).action_type).toBe("read_only");
  });
});
