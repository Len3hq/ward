import "dotenv/config";

/**
 * Minimal env-config loader for Phase 0.
 *
 * This is a placeholder for the fuller loader vendored from Len3's
 * `agent/src/config.ts` in Phase 2 (env config + MODELS map + brand constants).
 * For now it exposes only what the dev entrypoint needs.
 */

export type NodeEnv = "development" | "production" | "test";

export interface Config {
  telegramBotToken: string;
  nodeEnv: NodeEnv;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function nodeEnv(): NodeEnv {
  const value = process.env.NODE_ENV?.trim();
  if (value === "production" || value === "test") return value;
  return "development";
}

export function loadConfig(): Config {
  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    nodeEnv: nodeEnv(),
  };
}
