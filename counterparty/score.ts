import { createHash } from "node:crypto";

/**
 * The whole "work" this agent sells: a deterministic mapping from GoPlus's
 * token-security fields to a 0–100 score, a band, and human-readable flags.
 *
 * Be precise about what this is: it is **not** an independent audit. It is a
 * scoring layer over one public data source, and the report says so — every
 * report carries its source URL and the sha256 of the exact response body it was
 * derived from, so anyone can re-fetch and re-run `scoreToken` to get the same
 * number. That reproducibility is the point; a judge can verify the deliverable
 * instead of trusting it.
 */

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1/token_security";
const BASE_CHAIN_ID = 8453;

export const SCORER_VERSION = "1.0.0";

export interface RiskReport {
  subject: string;
  chain_id: number;
  checked_at: string;
  /** The address actually scored — may differ from `subject` when a ticker was resolved. */
  address: string;
  /** How `subject` became `address`. Ticker resolution is a heuristic; say so. */
  resolved_by: string;
  /** 0–100. Direction is stated in `scale` because it is genuinely ambiguous. */
  risk_score: number;
  /** Same thresholds the stub counterparty uses, so the two are interchangeable. */
  band: "high" | "elevated" | "low";
  scale: string;
  flags: string[];
  sources: Array<{ name: string; url: string; raw_sha256: string }>;
  scorer_version: string;
}

/** The GoPlus fields this scorer reads. All are strings ("0"/"1", or a decimal). */
export interface GoPlusToken {
  is_honeypot?: string;
  cannot_sell_all?: string;
  transfer_pausable?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  is_open_source?: string;
  slippage_modifiable?: string;
  is_blacklisted?: string;
  owner_address?: string;
  buy_tax?: string;
  sell_tax?: string;
  holder_count?: string;
  holders?: Array<{ percent?: string }>;
  lp_holders?: Array<{ is_locked?: number; percent?: string }>;
}

interface Rule {
  flag: string;
  penalty: number;
  hit: (t: GoPlusToken) => boolean;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Ordered so the report's flags read worst-first. Penalties are subtractive from
 * 100 and deliberately blunt — a defensible, legible rule set beats a tuned one
 * nobody can check.
 */
const RULES: Rule[] = [
  { flag: "honeypot: cannot be sold", penalty: 100, hit: (t) => is(t.is_honeypot) },
  {
    flag: "holders cannot sell their full balance",
    penalty: 40,
    hit: (t) => is(t.cannot_sell_all),
  },
  { flag: "contract can self-destruct", penalty: 30, hit: (t) => is(t.selfdestruct) },
  { flag: "source is not verified", penalty: 25, hit: (t) => t.is_open_source === "0" },
  { flag: "hidden owner", penalty: 25, hit: (t) => is(t.hidden_owner) },
  { flag: "mint authority is live", penalty: 20, hit: (t) => is(t.is_mintable) },
  { flag: "ownership can be reclaimed", penalty: 20, hit: (t) => is(t.can_take_back_ownership) },
  { flag: "sell tax over 10%", penalty: 20, hit: (t) => pct(t.sell_tax) > 0.1 },
  { flag: "transfers can be paused", penalty: 15, hit: (t) => is(t.transfer_pausable) },
  { flag: "buy tax over 10%", penalty: 15, hit: (t) => pct(t.buy_tax) > 0.1 },
  {
    flag: "slippage is modifiable by the owner",
    penalty: 15,
    hit: (t) => is(t.slippage_modifiable),
  },
  { flag: "LP is not locked", penalty: 15, hit: (t) => lpUnlocked(t) },
  { flag: "top-10 holders over 60%", penalty: 20, hit: (t) => topHolders(t) > 0.6 },
  { flag: "top-10 holders over 40%", penalty: 10, hit: (t) => between(topHolders(t), 0.4, 0.6) },
  { flag: "owner address retained", penalty: 10, hit: (t) => hasOwner(t) },
  { flag: "blacklist function present", penalty: 10, hit: (t) => is(t.is_blacklisted) },
  { flag: "fewer than 100 holders", penalty: 10, hit: (t) => holderCount(t) < 100 },
];

/** How `subject` became the address that was actually scored. */
export interface Resolution {
  address: string;
  /** Plain-language account of the step, carried into the report. */
  how: string;
  source?: { name: string; url: string; raw_sha256: string };
}

/** Pure. Same inputs → same report (modulo `checked_at`). */
export function scoreToken(
  subject: string,
  token: GoPlusToken,
  rawBody: string,
  resolution?: Resolution,
): RiskReport {
  const flags: string[] = [];
  let score = 100;
  for (const rule of RULES) {
    if (!rule.hit(token)) continue;
    flags.push(rule.flag);
    score -= rule.penalty;
  }
  score = Math.max(0, Math.min(100, score));

  const address = resolution?.address ?? subject;
  return {
    subject,
    address,
    resolved_by: resolution?.how ?? "subject was already an address",
    chain_id: BASE_CHAIN_ID,
    checked_at: new Date().toISOString(),
    risk_score: score,
    band: score < 30 ? "high" : score < 55 ? "elevated" : "low",
    scale: "0-100, higher is safer",
    flags,
    sources: [
      ...(resolution?.source ? [resolution.source] : []),
      {
        name: "goplus.token_security",
        url: goPlusUrl(address),
        raw_sha256: createHash("sha256").update(rawBody).digest("hex"),
      },
    ],
    scorer_version: SCORER_VERSION,
  };
}

export interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
}

/**
 * Pure. Pick the Base token a ticker most likely means: exact symbol match, on
 * Base, deepest liquidity.
 *
 * Ticker → address is genuinely ambiguous — many tokens share a symbol, and the
 * deepest pool is a heuristic, not a fact. It is resolved here (rather than
 * refusing tickers outright) because Ward's own intent parser usually sends a
 * symbol, but every report states the address it landed on and how, so a reader
 * can disagree with the resolution instead of being misled by it.
 */
export function pickBaseToken(pairs: DexPair[], symbol: string): DexPair | null {
  const wanted = symbol.trim().toUpperCase();
  const candidates = pairs.filter(
    (p) =>
      p.chainId === "base" &&
      p.baseToken?.symbol?.toUpperCase() === wanted &&
      /^0x[0-9a-fA-F]{40}$/.test(p.baseToken?.address ?? ""),
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, p) =>
    (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
  );
}

async function resolve(subject: string): Promise<Resolution> {
  const trimmed = subject.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { address: trimmed.toLowerCase(), how: "subject was already an address" };
  }
  if (!/^[A-Za-z0-9]{2,10}$/.test(trimmed)) {
    throw new Error(`not a token address or ticker: ${subject}`);
  }

  const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(trimmed)}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Dexscreener returned ${response.status}`);

  const rawBody = await response.text();
  const pairs = (JSON.parse(rawBody) as { pairs?: DexPair[] }).pairs ?? [];
  const pick = pickBaseToken(pairs, trimmed);
  if (!pick?.baseToken?.address) {
    throw new Error(`no Base token found for ticker ${trimmed}`);
  }

  const liquidity = Math.round(pick.liquidity?.usd ?? 0);
  return {
    address: pick.baseToken.address.toLowerCase(),
    how: `ticker "${trimmed.toUpperCase()}" resolved to the deepest Base pool (~$${liquidity} liquidity) — tickers are not unique`,
    source: {
      name: "dexscreener.search",
      url,
      raw_sha256: createHash("sha256").update(rawBody).digest("hex"),
    },
  };
}

/**
 * Resolve → fetch → score. Throws rather than returning a degraded report: an ACP
 * job that cannot be done honestly should be rejected, not delivered as junk —
 * Ward scores a junk deliverable at -0.4 trust, which is the correct outcome for us.
 */
export async function assess(subject: string): Promise<RiskReport> {
  const resolution = await resolve(subject);

  const response = await fetch(goPlusUrl(resolution.address), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`GoPlus returned ${response.status}`);

  const rawBody = await response.text();
  const parsed = JSON.parse(rawBody) as { result?: Record<string, GoPlusToken> };
  const token = parsed.result?.[resolution.address];
  if (!token || Object.keys(token).length === 0) {
    throw new Error(`GoPlus has no security data for ${resolution.address} on Base`);
  }

  return scoreToken(subject, token, rawBody, resolution);
}

function goPlusUrl(address: string): string {
  return `${GOPLUS_BASE}/${BASE_CHAIN_ID}?contract_addresses=${address}`;
}

function is(value: string | undefined): boolean {
  return value === "1";
}

function pct(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function between(value: number, low: number, high: number): boolean {
  return value > low && value <= high;
}

function hasOwner(token: GoPlusToken): boolean {
  const owner = token.owner_address?.trim().toLowerCase();
  return !!owner && owner !== ZERO_ADDRESS && owner !== "";
}

function holderCount(token: GoPlusToken): number {
  const n = Number(token.holder_count);
  // Absent data must not read as "zero holders" and fire the penalty.
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function topHolders(token: GoPlusToken): number {
  if (!token.holders?.length) return 0;
  return token.holders.slice(0, 10).reduce((sum, h) => sum + pct(h.percent), 0);
}

function lpUnlocked(token: GoPlusToken): boolean {
  // No LP data at all is not evidence of an unlocked LP — don't penalise it.
  if (!token.lp_holders?.length) return false;
  return !token.lp_holders.some((h) => h.is_locked === 1);
}
