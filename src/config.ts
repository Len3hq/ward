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

export interface CdpConfig {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
}

export interface AcpConfig {
  /** The registered agent wallet's EVM address — escrow draws on THIS address. */
  walletAddress: string;
  walletId: string;
  signerKey: string;
  builderCode: string | undefined;
}

export interface Config {
  /**
   * Gateway tokens. Neither channel is required and both may run at once — a user
   * who links the two accounts reaches the same authorization record from either.
   * `loadConfig` fails only when *no* gateway is configured.
   */
  telegramBotToken: string | undefined;
  discordBotToken: string | undefined;
  /** Optional: when absent, the agent node falls back to a deterministic memory recall. */
  openaiApiKey: string | undefined;
  models: Models;
  /**
   * Optional HTTP(S) proxy for Coinbase / CDP calls only — Coinbase geoblocks some
   * regions. Unset in a non-blocked deploy (e.g. Railway). See `src/net.ts`.
   */
  cdpProxyUrl: string | undefined;
  /** CDP credentials — present → the real wallet provider, absent → the stub. */
  cdp: CdpConfig | undefined;
  /** Spend-permission network: base-sepolia (default) or base. */
  baseNetwork: "base" | "base-sepolia";
  /** ACP counterparty market: "stub" (default, simulated) or "virtuals" (real, go/no-go). */
  acpMode: "stub" | "virtuals";
  acp: AcpConfig | undefined;
  /** Default escrow budget for an ACP job, in USD. */
  acpBudgetUsd: number;
  nodeEnv: NodeEnv;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function nodeEnv(): NodeEnv {
  const value = process.env.NODE_ENV?.trim();
  if (value === "production" || value === "test") return value;
  return "development";
}

function cdpConfig(): CdpConfig | undefined {
  const apiKeyId = optional("CDP_API_KEY_ID");
  const apiKeySecret = optional("CDP_API_KEY_SECRET");
  const walletSecret = optional("CDP_WALLET_SECRET");
  if (apiKeyId && apiKeySecret && walletSecret) return { apiKeyId, apiKeySecret, walletSecret };
  return undefined;
}

function acpConfig(): AcpConfig | undefined {
  const walletAddress = optional("ACP_WALLET_ADDRESS");
  const walletId = optional("ACP_WALLET_ID");
  const signerKey = optional("ACP_SIGNER_KEY");
  if (walletAddress && walletId && signerKey) {
    return { walletAddress, walletId, signerKey, builderCode: optional("ACP_BUILDER_CODE") };
  }
  return undefined;
}

export function loadConfig(): Config {
  const telegramBotToken = optional("TELEGRAM_BOT_TOKEN");
  const discordBotToken = optional("DISCORD_BOT_TOKEN");
  if (!telegramBotToken && !discordBotToken) {
    throw new Error(
      "No chat gateway configured. Set TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, or both. " +
        "Copy .env.example to .env and fill it in.",
    );
  }

  return {
    telegramBotToken,
    discordBotToken,
    openaiApiKey: optional("OPENAI_API_KEY"),
    models: {
      agent: optional("WARD_AGENT_MODEL") ?? "gpt-4o-mini",
      guard: optional("WARD_GUARD_MODEL") ?? "gpt-4o-mini",
    },
    cdpProxyUrl: optional("CDP_PROXY_URL"),
    cdp: cdpConfig(),
    baseNetwork: optional("BASE_NETWORK") === "base" ? "base" : "base-sepolia",
    acpMode: optional("ACP_MODE") === "virtuals" ? "virtuals" : "stub",
    acp: acpConfig(),
    acpBudgetUsd: Number(optional("WARD_ACP_BUDGET_USD") ?? "0.5") || 0.5,
    nodeEnv: nodeEnv(),
  };
}
