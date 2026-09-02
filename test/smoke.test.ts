import { expect, test } from "bun:test";

import { loadConfig } from "../src/config.ts";

// Phase 0 smoke test. Real coverage — memory read/write, the deletion gate,
// revocation, cap enforcement — lands in Phases 1 and 7.

test("config loader reads TELEGRAM_BOT_TOKEN", () => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  expect(loadConfig().telegramBotToken).toBe("test-token");
});

test("config loader throws when TELEGRAM_BOT_TOKEN is missing", () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  expect(() => loadConfig()).toThrow("TELEGRAM_BOT_TOKEN");
});
