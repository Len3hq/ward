import { z } from "zod";

import { loadConfig } from "../config.ts";
import { parseUsd } from "./prompts.ts";

/**
 * Intent parsing. Adapted from Len3's `routing/intentTables.ts` — a deterministic
 * table pre-empts an LLM round-trip on obvious cases; everything else gets one
 * structured `gpt-4o-mini` call. Trimmed to Ward's action set.
 */

export const INTENT_ACTIONS = [
  "connect_wallet",
  "grant_permission",
  "revoke",
  "swap",
  "x402_data_purchase",
  "acp_job",
  "read_only",
] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

/** Actions that move money and therefore need the confirmation + gate. */
export const SPEND_ACTIONS: ReadonlySet<IntentAction> = new Set<IntentAction>([
  "swap",
  "x402_data_purchase",
  "acp_job",
]);

export interface ParsedIntent {
  action_type: IntentAction;
  amount_usd?: number;
  /** e.g. "USDC/ETH" for a swap. */
  pair?: string;
  /** token symbol / mint for x402 or acp_job. */
  token?: string;
  /** x402 endpoint hint. */
  endpoint?: string;
  source: "table" | "llm" | "fallback";
}

const BASE_TOKENS = [
  "eth",
  "weth",
  "usdc",
  "usdbc",
  "usdt",
  "dai",
  "cbeth",
  "wbtc",
  "aero",
  "degen",
];
const TOKEN_RE = new RegExp(`\\b(${BASE_TOKENS.join("|")})\\b`, "gi");

/** What a "revoke" / "pause" targets: a spend category, or "permission" (the on-chain grant + everything). */
export type RevokeScope = "swap" | "x402_data_purchase" | "acp_job" | "permission";

function revokeScope(t: string): RevokeScope {
  if (/\b(permission|allowance|grant|everything|all|wallet|trading altogether)\b/.test(t)) {
    return "permission";
  }
  if (/\bswap|trad|exchang/.test(t)) return "swap";
  if (/\bx402|data|premium|purchase\b/.test(t)) return "x402_data_purchase";
  if (/\bacp|agent|hir/.test(t)) return "acp_job";
  return "permission"; // bare "revoke" / "stop" → the safe, broad reading
}

function extractPair(text: string): string | undefined {
  const found = [...text.matchAll(TOKEN_RE)].map((m) => m[1]!.toUpperCase());
  if (found.length >= 2) return `${found[0]}/${found[1]}`;
  if (found.length === 1) return found[0];
  return undefined;
}

/** Obvious cases — no LLM. Returns `null` when the text is ambiguous. */
export function tableIntent(text: string): ParsedIntent | null {
  const t = text.toLowerCase().trim();

  if (/\b(connect|link|set\s?up)\b.*\b(wallet|account)\b/.test(t) || /^\/?connect\b/.test(t)) {
    return { action_type: "connect_wallet", source: "table" };
  }
  if (/\b(grant|approve|authoriz\w*|set)\b.*\b(permission|allowance|spend|limit)\b/.test(t)) {
    return { action_type: "grant_permission", amount_usd: parseUsd(t), source: "table" };
  }
  if (/\b(revoke|pause|stop|disable|halt|freeze)\b/.test(t)) {
    return { action_type: "revoke", token: revokeScope(t), source: "table" };
  }
  if (
    /\b(swap|trade|convert|exchange|rebalance)\b/.test(t) ||
    /\b(buy|sell)\b.*\b(for|to|into|with)\b/.test(t)
  ) {
    return { action_type: "swap", amount_usd: parseUsd(t), pair: extractPair(t), source: "table" };
  }
  if (
    /\b(risk\s*(score|assessment|check)|is\s+\S+\s+(a\s+)?(rug|scam|safe)|assess\b.*\btoken|audit\b.*\btoken)\b/.test(
      t,
    )
  ) {
    return { action_type: "acp_job", token: extractPair(t), source: "table" };
  }
  if (
    /\b(whale|smart\s*money|holder|inflow|outflow|token\s*(flow|analytics)|on-?chain\s*data)\b/.test(
      t,
    )
  ) {
    return { action_type: "x402_data_purchase", token: extractPair(t), source: "table" };
  }
  if (
    /\b(my|the)\b.*\b(limit|cap|balance|authorization|risk profile|spent|allowance)\b/.test(t) ||
    /^\s*(what|how much|show|status)\b/.test(t)
  ) {
    return { action_type: "read_only", source: "table" };
  }
  return null;
}

const llmIntentSchema = z.object({
  action_type: z.enum(INTENT_ACTIONS),
  amount_usd: z.number().positive().optional(),
  pair: z.string().optional(),
  token: z.string().optional(),
  endpoint: z.string().optional(),
});

/** Full parse: table first, then one `gpt-4o-mini` structured call, then `read_only`. */
export async function parseIntent(text: string): Promise<ParsedIntent> {
  const fromTable = tableIntent(text);
  if (fromTable) return fromTable;

  const config = loadConfig();
  if (!config.openaiApiKey) return { action_type: "read_only", source: "fallback" };

  try {
    const { ChatOpenAI } = await import("@langchain/openai");
    const model = new ChatOpenAI({
      model: config.models.guard,
      apiKey: config.openaiApiKey,
      temperature: 0,
    }).withStructuredOutput(llmIntentSchema, { name: "parse_intent" });

    const parsed = await model.invoke([
      {
        role: "system",
        content:
          "Classify the user's message into one Ward action. read_only = a question or chit-chat, " +
          "no money moves. Only pick swap / x402_data_purchase / acp_job / grant_permission / revoke / " +
          "connect_wallet when the user is clearly asking for that action. Extract amount_usd, pair " +
          '(like "USDC/ETH"), token, endpoint when present.',
      },
      { role: "user", content: text },
    ]);
    return { ...parsed, source: "llm" };
  } catch {
    return { action_type: "read_only", source: "fallback" };
  }
}

export function describeIntent(intent: ParsedIntent): string {
  switch (intent.action_type) {
    case "swap":
      return `Swap${intent.amount_usd ? ` $${intent.amount_usd}` : ""}${intent.pair ? ` ${intent.pair.replace("/", " → ")}` : ""}`;
    case "x402_data_purchase":
      return `Buy premium data${intent.token ? ` on ${intent.token}` : ""}`;
    case "acp_job":
      return `Hire an agent to assess${intent.token ? ` ${intent.token}` : " a token"}`;
    default:
      return intent.action_type.replace(/_/g, " ");
  }
}
