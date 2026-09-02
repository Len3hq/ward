import "dotenv/config";

/**
 * Env-config loader. Adapted from Len3's `agent/src/config.ts` (env config +
 * MODELS map + brand constants), trimmed to what Ward uses.
 */

export type NodeEnv = "development" | "production" | "test";

export const BRAND = {
  name: "Ward",
  tagline: "an agent that cannot exceed what you once told it",
} as const;

export interface Models {
  /** Main conversational + tool-calling model. */
  agent: string;
  /** Cheap model for the guard / classification / extraction. */
  guard: string;
}

export interface Config {
  telegramBotToken: string;
  /** Optional: when absent, the agent node falls back to a deterministic memory recall. */
  openaiApiKey: string | undefined;
  models: Models;
  /**
   * Optional HTTP(S) proxy for Coinbase / CDP calls only — Coinbase geoblocks some
   * regions. Unset in a non-blocked deploy (e.g. Railway). See `src/net.ts`.
   */
  cdpProxyUrl: string | undefined;
  nodeEnv: NodeEnv;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function nodeEnv(): NodeEnv {
  const value = process.env.NODE_ENV?.trim();
  if (value === "production" || value === "test") return value;
  return "development";
}

export function loadConfig(): Config {
  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    openaiApiKey: optional("OPENAI_API_KEY"),
    models: {
      agent: optional("WARD_AGENT_MODEL") ?? "gpt-4o-mini",
      guard: optional("WARD_GUARD_MODEL") ?? "gpt-4o-mini",
    },
    cdpProxyUrl: optional("CDP_PROXY_URL"),
    nodeEnv: nodeEnv(),
  };
}
