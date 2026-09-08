import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import type { Telegraf } from "telegraf";

import { type IntentAction, parseIntent } from "../src/agent/intent.ts";

import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, HELP, welcome } from "../src/gateway/help.ts";
import { BOT_COMMANDS, isSlashOnlyCommand, resolveCommand } from "../src/gateway/commands.ts";
import { render } from "../src/telegram/gateway.ts";
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
    expect(chars(welcome("telegram"))).toBeLessThanOrEqual(4096);
    expect(chars(welcome("discord"))).toBeLessThanOrEqual(4096);
  });
});

/**
 * Autocompleting a command that nothing handles is worse than not advertising it:
 * the user types it, Telegram offered it, and Ward says nothing at all.
 *
 * Registration is table-driven now, so this checks the two halves that can still
 * disagree: every advertised name must resolve to a row, and every row's handler must
 * actually be reached — identity commands through the loop, the rest by name.
 */
test("every advertised command is actually wired up", () => {
  const source = readFileSync("src/telegram/gateway.ts", "utf8");
  // The loop that registers every identity row, including the one-word aliases.
  expect(source).toMatch(/for \(const spec of COMMANDS\)/);

  for (const { command } of BOT_COMMANDS) {
    const spec = resolveCommand(command);
    expect(spec, `/${command} is advertised but is not in the table`).toBeDefined();
    if (isSlashOnlyCommand(spec!.base)) continue;
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
  expect(HELP).toContain("Claude Code");
  expect(HELP).not.toMatch(/\bMCP\b/);
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
    // swap / send are disabled — the help no longer promises them.
    ["generate my wallet", "generate_wallet", "generate my wallet"],
    ["grant a $50 daily permission", "grant_permission", "grant a $50 daily permission"],
    ["pause data purchases", "revoke", "pause data purchases"],
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

/**
 * The reason `welcome` takes a channel at all. One account reachable from Telegram,
 * Discord and an MCP client was invisible until you tapped a command described as
 * "another app" — so the first screen now names them, and this is what stops that
 * regressing to a generic phrase again. It also pins the bug the parameter exists to
 * prevent: offering Discord to someone who is already standing in Discord.
 */
describe("the welcome names the other ways in", () => {
  test("Telegram is pointed at Discord and at MCP clients", () => {
    const text = welcome("telegram");
    expect(text).toContain("Discord");
    expect(text).toContain("/link_discord");
    expect(text).toContain("Claude Code or Cursor");
    expect(text).not.toContain("/link_telegram");
  });

  test("Discord is pointed at Telegram and at MCP clients", () => {
    const text = welcome("discord");
    expect(text).toContain("Telegram");
    expect(text).toContain("/link_telegram");
    expect(text).toContain("Claude Code or Cursor");
    expect(text).not.toContain("/link_discord");
  });

  /**
   * The welcome is markdown now, and Telegram only renders markup when the reply asks
   * for HTML. Sent plain, the first screen anyone sees is full of literal asterisks.
   */
  test("Telegram sends the welcome rendered, not raw", () => {
    const source = readFileSync("src/telegram/gateway.ts", "utf8");
    expect(source).toMatch(/render\(welcome\("telegram"\)\)/);
    expect(source).toMatch(/parse_mode: "HTML"/);
  });

  test("it survives the markdown-to-HTML pass with its emphasis intact", () => {
    const html = render(welcome("telegram"));
    expect(html).toContain("<b>Ward</b>");
    expect(html).toContain("<b>What I can do</b>");
    // Nothing may be left for Telegram to show as literal markup.
    expect(html).not.toContain("**");
  });

  /**
   * Telegram links a bare `/command` into something you tap to run. Wrapping one in
   * backticks turns it into a `<code>` span — copyable and inert — on the one screen
   * whose whole job is getting a new user to the next step.
   */
  test("the commands it names stay tappable", () => {
    for (const channel of ["telegram", "discord"] as const) {
      const html = render(welcome(channel));
      expect(html).toContain("/link_mcp");
      expect(html).not.toMatch(/<code>\/[a-z_]+<\/code>/);
    }
  });

  test("it makes the case before it asks the question", () => {
    const text = welcome("telegram");
    // The three things that are actually unusual here.
    expect(text).toContain("Sibyl Memory");
    expect(text).toMatch(/revocable/i);
    expect(text).toMatch(/remember/i);
    // And it still says what Ward does, in words someone could repeat back.
    expect(text).toContain("Buy on-chain data");
  });

  test("the risk-tolerance question stays the last thing asked", () => {
    for (const channel of ["telegram", "discord"] as const) {
      const lines = welcome(channel).trimEnd().split("\n");
      expect(lines[lines.length - 1]).toContain("risk tolerance");
    }
  });
});

/** The command menu is read without tapping anything, so it names the apps by name. */
test("the menu names Discord and the coding clients without being clicked", () => {
  const menu = BOT_COMMANDS.map((c) => `${c.command} ${c.description}`).join("\n");
  expect(menu).toContain("Discord");
  expect(menu).toMatch(/Claude Code|Cursor/);
});
