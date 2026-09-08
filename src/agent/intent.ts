import { z } from "zod";

import { loadConfig } from "../config.ts";
import { logError } from "../log.ts";
import { parseUsd } from "./prompts.ts";

/**
 * Intent parsing. Adapted from Len3's `routing/intentTables.ts` — a deterministic
 * table pre-empts an LLM round-trip on obvious cases; everything else gets one
 * structured `gpt-4o-mini` call. Trimmed to Ward's action set.
 */

export const INTENT_ACTIONS = [
  "generate_wallet",
  "grant_permission",
  "revoke",
  "swap",
  "send",
  "x402_data_purchase",
  "acp_job",
  "balance",
  "read_only",
] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

/**
 * Actions that move money and therefore need the confirmation + gate.
 *
 * `swap` and `send` are listed, but currently switched off one layer up — see
 * `src/agent/transfers.ts`. `routerNode` diverts them to a neutral decline before
 * this set is consulted while transfers are disabled.
 */
export const SPEND_ACTIONS: ReadonlySet<IntentAction> = new Set<IntentAction>([
  "swap",
  "send",
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
  /**
   * How this was decided — the field to read in a `event=intent` log line.
   * `table` deterministic rules · `smalltalk` nothing money-shaped, no model call
   * · `llm` one `gpt-4o-mini` round trip · `fallback` that call failed.
   */
  source: "table" | "smalltalk" | "llm" | "fallback";
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

/**
 * Tokens whose amounts are NOT dollars. Every cap in Ward is in USD, so "0.0001 eth"
 * is not a quantity it can gate — and reading it as $0.0001, which is what happened,
 * confirms an action a thousand times smaller than the user asked for.
 *
 * Stablecoins are deliberately absent: "25 USDC" is $25 to within the precision
 * anyone cares about here, and treating it as unquantifiable would reject the most
 * common phrasing there is.
 */
const PRICED_TOKENS = ["eth", "weth", "cbeth", "wbtc", "aero", "degen"];
const TOKEN_AMOUNT_RE = new RegExp(
  String.raw`(?<![$\d.])(\d+(?:\.\d+)?)\s*(${PRICED_TOKENS.join("|")})\b`,
  "i",
);

/** An amount the user expressed in a token rather than in dollars, if there is one. */
export function tokenDenominatedAmount(
  text: string,
): { amount: number; symbol: string } | undefined {
  const match = text.match(TOKEN_AMOUNT_RE);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { amount, symbol: match[2]!.toUpperCase() };
}

/** A destination address, preserved in the case the user typed it. */
export function extractAddress(text: string): string | undefined {
  return text.match(/\b0x[a-fA-F0-9]{40}\b/)?.[0];
}

/**
 * The token a data / assessment request is *about* — a ticker or 0x address.
 *
 * Tickers are upper-cased; addresses are NOT. Upper-casing everything turned
 * "risk score for 0x4200…" into `0X4200…`, which then failed the `^0x` test in
 * `subjectMismatch` and was refused as "a ticker, not a contract address" — for an
 * address the user had typed correctly. It only bit when the address followed one of
 * the keywords below ("for", "on", "about", "is"), which is how most people write it.
 */
function extractSubject(text: string): string | undefined {
  const keyed = text.match(
    /\b(?:assess|check|analy\w*|audit|score|risk|about|on|for|is)\s+(?:the\s+|token\s+|a\s+)?(0x[a-fA-F0-9]{40}|[A-Z][A-Z0-9]{1,9})\b/,
  );
  if (keyed) {
    const found = keyed[1]!;
    return /^0x/i.test(found) ? found : found.toUpperCase();
  }
  const address = text.match(/\b0x[a-fA-F0-9]{40}\b/);
  if (address) return address[0];
  const ticker = text.match(/\b[A-Z]{2,10}\b/);
  return ticker ? ticker[0] : undefined;
}

/**
 * Openings that ask ABOUT an action rather than requesting one.
 *
 * "How do I grant eth permission" used to match the grant rule on `grant` +
 * `permission` and execute a real on-chain grant — a question that cost gas, changed
 * the user's authority, and answered a different one than was asked. "how do i
 * revoke" was worse: it revoked the permission and paused every action type.
 *
 * Deliberately narrow, and anchored to the start of the message. "can you…" /
 * "could you…" are polite REQUESTS and must keep working, so they are not here; only
 * openings that ask for an explanation are. A turn that matches this never reaches an
 * executing rule — it is classified `read_only` and answered by the agent node, which
 * knows the capabilities and can explain them.
 */
const ASKS_ABOUT_AN_ACTION =
  /^\s*(?:how\s+(?:do|does|did|can|could|would|should|is|are|difficult|hard|easy)\b|what\s+(?:is|are|do|does|happens|would|should)\b|what'?s\s+(?:the\s+)?(?:point|difference|process|best)\b|should\s+i\b|is\s+it\s+(?:possible|safe)\b|do\s+i\s+(?:need|have\s+to)\b|why\s+(?:do|does|would|should|is|are|can|can't|cant)\b|can\s+you\s+explain\b|explain\b|tell\s+me\s+(?:about|how)\b|what\s+do\s+you\s+mean\b)/;

/**
 * Asking about the CATALOGUE rather than for anything in it.
 *
 * Checked before every other rule, because these phrases are made of the same words
 * the data rules match on — "what onchain data sources do you have" is "on-chain
 * data" surrounded by a question about the menu. The tell is a possessive or
 * enumerating verb aimed at Ward ("do you have", "can you buy", "what … are
 * available"), never a subject to look up.
 */
const ASKS_FOR_THE_MENU =
  /\b(?:what|which|list|show\s+me)\b[^?]*\b(?:data\s+(?:sources?|providers?|feeds?)|endpoints?|sources?|apis?|catalogue|catalog)\b|\b(?:endpoints?|data\s+sources?)\b[^?]*\b(?:do\s+you\s+have|are\s+available|can\s+you\s+(?:buy|use|access)|exist)\b|\bwhat\s+(?:can|could)\s+you\s+(?:buy|fetch|look\s+up|access)\b/;

/** Obvious cases — no LLM. Returns `null` when the text is ambiguous. */
export function tableIntent(text: string): ParsedIntent | null {
  const t = text.toLowerCase().trim();

  // Asking WHAT Ward can buy is never itself a purchase. "What onchain data sources
  // do you have" matched `on-chain data` and was answered with "Buy 'Nansen Smart
  // Money Holdings' (~$0.05). Confirm?" — a price quote in reply to a question about
  // the menu. The agent node has `discover_x402_endpoints` and answers this for free.
  if (ASKS_FOR_THE_MENU.test(t)) return { action_type: "read_only", source: "table" };

  const asksAbout = ASKS_ABOUT_AN_ACTION.test(t);

  // Every rule from here to the `balance` check EXECUTES something. A question is
  // routed past all of them; the read-only classifications below are safe either way.
  if (!asksAbout) {
    const action = executableIntent(text, t);
    if (action) return action;
  } else {
    // One exemption, and it is not a loophole. Buying data is ASKED for — "what is
    // smart money buying on Base" is a question in form and a purchase in intent,
    // and the guard was swallowing every one of them. It is safe to exempt because
    // a data purchase always reaches `confirm` and shows its price first; the
    // actions the guard exists for — grant, revoke, generate a wallet — change
    // authority with no price prompt at all, and stay behind it.
    const data = x402Intent(text, t);
    if (data) return data;
  }

  if (
    /\b(balance|balances|holdings|portfolio)\b/.test(t) ||
    /\bhow much\b.*\b(usdc|eth|do i have|have i got|is in (my|the) wallet)\b/.test(t)
  ) {
    return { action_type: "balance", source: "table" };
  }
  if (
    /\b(my|the)\b.*\b(limit|cap|balance|authorization|risk profile|spent|allowance)\b/.test(t) ||
    /^\s*(what|how much|show|status)\b/.test(t)
  ) {
    return { action_type: "read_only", source: "table" };
  }

  // A question that matched nothing else is still a question. Returning `null` here
  // would hand it to the LLM parser, which might yet call it an action; the whole
  // point of the guard is that it cannot.
  if (asksAbout) return { action_type: "read_only", source: "table" };
  return null;
}

/** The rules that cause something to happen. Reached only for non-interrogative text. */
function executableIntent(text: string, t: string): ParsedIntent | null {
  // CDP *creates* the account — there is no external wallet to connect. "connect"
  // and friends stay matched anyway: it is what people type, and what earlier
  // builds (and DEMO.md) told them to.
  if (
    /\b(generate|create|make|open|new|connect|link|set\s?up)\b.*\b(wallet|account)\b/.test(t) ||
    /^\/?(generate|connect)\b/.test(t)
  ) {
    return { action_type: "generate_wallet", source: "table" };
  }
  if (/\b(grant|approve|authoriz\w*|set)\b.*\b(permission|allowance|spend|limit)\b/.test(t)) {
    return { action_type: "grant_permission", amount_usd: parseUsd(t), source: "table" };
  }
  if (/\b(revoke|pause|stop|disable|halt|freeze)\b/.test(t)) {
    return { action_type: "revoke", token: revokeScope(t), source: "table" };
  }
  // Before `swap`, and requiring a destination: "send $10 to 0x…" is unambiguous
  // only because an address is present. Without one this falls through, and the user
  // is asked for it rather than having an amount guessed at.
  if (/\b(send|transfer|pay|withdraw)\b/.test(t) && /\b0x[a-fA-F0-9]{40}\b/.test(t)) {
    return {
      action_type: "send",
      amount_usd: parseUsd(t),
      token: extractAddress(text),
      source: "table",
    };
  }
  if (
    /\b(swap|trade|convert|exchange|rebalance)\b/.test(t) ||
    /\b(buy|sell)\b.*\b(for|to|into|with)\b/.test(t)
  ) {
    return { action_type: "swap", amount_usd: parseUsd(t), pair: extractPair(t), source: "table" };
  }
  if (/\bhire\b.*\b(agent|someone)\b|\bacp\b.*\bjob\b|\bpost\b.*\bacp\b/.test(t)) {
    return { action_type: "acp_job", token: extractSubject(text), source: "table" };
  }
  const data = x402Intent(text, t);
  if (data) return data;

  // Nothing executable. The caller falls through to `balance` / `read_only`, which is
  // why the spend rules above must come first: "swap my balance into ETH" is a swap.
  return null;
}

/**
 * Asking for on-chain data Ward can buy.
 *
 * Its own function because `tableIntent` reaches it down two paths: the ordinary one,
 * and the question path — a data request is normally phrased as a question, so the
 * interrogative guard must not swallow it.
 *
 * The vocabulary tracks the catalogue. It grew with the Nansen entries: holders and
 * concentration, netflow, transfers, PnL leaderboards, who bought and sold, wallet
 * counterparties. A word the catalogue can answer but this cannot spell is an
 * endpoint nobody can reach.
 */
function x402Intent(text: string, t: string): ParsedIntent | null {
  // NOTE: no bare `holdings`/`holds` — "show me my holdings" is a question about the
  // user's OWN wallet and belongs to the `balance` rule. Nansen's Smart Money
  // Holdings is reached through "smart money" anyway, and "who holds …" through the
  // `who …` alternative below.
  const matches =
    /\b(risk\s*(score|assessment|check|rating)|is\s+\S+\s+(a\s+)?(rug|scam|safe|honeypot)|assess\b.*\btoken|audit\b.*\btoken|whale|smart\s*money|holders?|concentration|inflow|outflow|net\s*flow|netflow|token\s*(flow|analytics|price|risk)|on-?chain\s*data|premium\s*data|liquidity\s*depth|transfers?|pnl|profit\s*and\s*loss|leaderboard|counterpart\w*|screener|who\s+(bought|sold|holds|is\s+buying|is\s+selling))\b/.test(
      t,
    );
  if (!matches) return null;
  return { action_type: "x402_data_purchase", token: extractSubject(text), source: "table" };
}

/**
 * Every field required, every optional one nullable — and no `.positive()`.
 *
 * OpenAI's structured outputs are strict: the JSON schema must list EVERY property in
 * `required`, and it rejects validation keywords like `exclusiveMinimum`. The obvious
 * spelling — `.optional()` on the fields that are usually absent — produced a schema
 * OpenAI refused outright:
 *
 *   400 Invalid schema for response_format 'parse_intent': 'required' is required to
 *   be supplied and to be an array including every key in properties. Missing 'amount_usd'
 *
 * Every call. And `parseIntent` catches that and returns `read_only`, so the failure
 * was invisible twice over: the LLM half of intent parsing had never once worked, and
 * every message the table missed paid ~1s for a round trip that could only fail. The
 * `source=fallback` line in the logs is what finally showed it.
 *
 * The range check moves into `toParsedIntent` below, where it belongs anyway.
 */
export const llmIntentSchema = z.object({
  action_type: z.enum(INTENT_ACTIONS),
  amount_usd: z.number().nullable(),
  pair: z.string().nullable(),
  token: z.string().nullable(),
  endpoint: z.string().nullable(),
});

type LlmIntent = z.infer<typeof llmIntentSchema>;

/** Nulls out, and an amount only when it is one. */
function toParsedIntent(parsed: LlmIntent): ParsedIntent {
  const amountUsd =
    parsed.amount_usd !== null && Number.isFinite(parsed.amount_usd) && parsed.amount_usd > 0
      ? parsed.amount_usd
      : undefined;
  return {
    action_type: parsed.action_type,
    amount_usd: amountUsd,
    pair: parsed.pair ?? undefined,
    token: parsed.token ?? undefined,
    endpoint: parsed.endpoint ?? undefined,
    source: "llm",
  };
}

/**
 * Text that cannot be an action request, because it contains nothing an action is
 * made of: no amount, no address, no token, and none of the verbs Ward acts on.
 *
 * This exists for latency. Everything the table misses costs a `gpt-4o-mini` round
 * trip that runs BEFORE the agent's own model call, so "hey" or "thanks" used to
 * take two sequential model calls to answer — the single biggest avoidable delay in
 * a Telegram reply. Deliberately conservative: one money-ish word anywhere, or any
 * digit, and the LLM parse still runs.
 */
const MONEY_SIGNAL =
  /[\d$]|\b0x|\b(swap|trade|convert|exchange|rebalance|buy|sell|send|transfer|pay|withdraw|deposit|fund|hire|acp|x402|revoke|pause|resume|stop|grant|approve|permission|allowance|wallet|account|balance|holdings|portfolio|limit|cap|spend|spent|usdc|usdt|dai|eth|weth|cbeth|wbtc|aero|degen|token|coin|price|risk|rug|scam|whale|holder|data|endpoint|address|gas|onchain|on-chain|amount|worth|dollars?|usd|money|funds?|move|ether|crypto|bucks?)\b/i;

export function isSmallTalk(text: string): boolean {
  return !MONEY_SIGNAL.test(text);
}

/** Full parse: table first, then one `gpt-4o-mini` structured call, then `read_only`. */
export async function parseIntent(text: string): Promise<ParsedIntent> {
  const fromTable = tableIntent(text);
  if (fromTable) return fromTable;

  // Nothing to classify — skip the model round trip entirely.
  if (isSmallTalk(text)) return { action_type: "read_only", source: "smalltalk" };

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
          "no money moves. balance = the user asking what they hold on chain (wallet balance, " +
          "USDC, ETH, whether they can afford something). " +
          "Only pick swap / x402_data_purchase / acp_job / grant_permission / revoke / " +
          "generate_wallet when the user is clearly asking for that action. send = moving USDC to " +
          "an 0x address the user names; put that address in `token`. Extract amount_usd, pair " +
          '(like "USDC/ETH"), token, endpoint when present.\n' +
          "A question ABOUT an action is read_only, never the action itself. " +
          '"How do I grant a permission?", "should I revoke?", "what happens if I swap?" and ' +
          '"how does the spend permission work?" are all read_only — the user is asking to be ' +
          "told something, not asking you to do it. Choose the action only when the message " +
          "would still read as an instruction with the question mark removed.",
      },
      { role: "user", content: text },
    ]);
    return toParsedIntent(parsed);
  } catch (error) {
    // Fail safe — an unparseable message is a question, never an action. But say so:
    // this branch silently swallowed a 400 on every single call for weeks.
    logError("intent.llm.failed", error, { chars: text.length });
    return { action_type: "read_only", source: "fallback" };
  }
}

export function describeIntent(intent: ParsedIntent): string {
  switch (intent.action_type) {
    case "swap":
      return `Swap${intent.amount_usd ? ` $${intent.amount_usd}` : ""}${intent.pair ? ` ${intent.pair.replace("/", " → ")}` : ""}`;
    case "send":
      return `Send${intent.amount_usd ? ` $${intent.amount_usd}` : ""}${intent.token ? ` to ${intent.token}` : ""}`;
    case "x402_data_purchase":
      return `Buy premium data${intent.token ? ` on ${intent.token}` : ""}`;
    case "acp_job":
      return `Hire an agent to assess${intent.token ? ` ${intent.token}` : " a token"}`;
    case "balance":
      return "Read your wallet balance";
    default:
      return intent.action_type.replace(/_/g, " ");
  }
}
