import { afterEach, beforeEach, expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";

/**
 * Phase 0 smoke test, updated for the Phase 11 contract: **neither** gateway token
 * is required on its own, and `loadConfig` fails only when no gateway at all is
 * configured. Ward runs on Telegram, Discord, or both.
 *
 * These save and restore both tokens rather than deleting one and trusting the
 * ambient environment. `src/config.ts` imports `dotenv/config`, so a developer's
 * real `.env` is loaded during tests — an earlier version of this file passed only
 * because `DISCORD_BOT_TOKEN` happened to be empty, and started failing the moment
 * a real one was added.
 */

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function withGateways(telegram?: string, discord?: string): void {
  if (telegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = telegram;
  if (discord === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = discord;
}

test("config loader reads TELEGRAM_BOT_TOKEN", () => {
  withGateways("test-token", undefined);
  expect(loadConfig().telegramBotToken).toBe("test-token");
});

test("Telegram alone is enough", () => {
  withGateways("tg", undefined);
  const config = loadConfig();
  expect(config.telegramBotToken).toBe("tg");
  expect(config.discordBotToken).toBeUndefined();
});

test("Discord alone is enough — Telegram is not required", () => {
  withGateways(undefined, "dc");
  const config = loadConfig();
  expect(config.discordBotToken).toBe("dc");
  expect(config.telegramBotToken).toBeUndefined();
});

test("both may run at once, against one authorization record", () => {
  withGateways("tg", "dc");
  const config = loadConfig();
  expect(config.telegramBotToken).toBe("tg");
  expect(config.discordBotToken).toBe("dc");
});

test("config loader throws when no gateway at all is configured", () => {
  withGateways(undefined, undefined);
  // Deliberately not asserting on the thrown value's shape: a failed `toThrow` here
  // prints whatever `loadConfig()` returned, which carries live CDP and ACP secrets
  // from the developer's .env.
  let threw = false;
  try {
    loadConfig();
  } catch (error) {
    threw = true;
    expect(String(error)).toMatch(/TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN/);
  }
  expect(threw).toBe(true);
});
