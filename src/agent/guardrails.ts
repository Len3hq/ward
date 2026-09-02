/**
 * Input guardrails. Adapted from Len3's `agent/src/security/guardrails.ts`:
 * explicit-injection hard block, suspicious-pattern flag, crypto keyword
 * fast-path, `sanitizeUrls` trusted-domain allowlist, `<user_input>` wrapping,
 * and `validateExternalData()` between any external payload and the LLM/executor.
 */

// --- explicit injection: hard block ---

const EXPLICIT_INJECTION = [
  /\b(ignore|disregard|forget|override)\b[\s\w]*\b(previous|prior|earlier|above|all|any|your)\b[\s\w]*\b(instructions?|prompts?|rules?|context|directives?)\b/i,
  /\byou are now (a|an|the)\b/i,
  /\bsystem prompt\b\s*[:=]/i,
  /\bDAN\b.*\bjailbreak\b/i,
  /\bpretend (you are|to be)\b.*\b(no|without) (rules|restrictions|limits)\b/i,
  /\b(reveal|print|show|repeat|output)\b.*\b(system prompt|your instructions|initial prompt)\b/i,
];

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

export function screenUserInput(text: string): GuardVerdict {
  for (const pattern of EXPLICIT_INJECTION) {
    if (pattern.test(text)) return { ok: false, reason: "explicit prompt-injection pattern" };
  }
  return { ok: true };
}

// --- suspicious patterns: flag, don't block ---

const SUSPICIOUS = [
  { re: /\b(curl|wget|fetch)\b.*\bhttps?:\/\//i, why: "embedded fetch command" },
  { re: /[A-Za-z0-9+/]{120,}={0,2}/, why: "long base64-like blob" },
  { re: /\b(eval|exec|require|import)\s*\(/i, why: "code-execution syntax" },
  { re: /<\|.*?\|>|\[INST\]|\[\/INST\]|<<SYS>>/i, why: "chat-template markers" },
  {
    re: /\b(you must|from now on|always respond)\b.*\b(as|like|pretending)\b/i,
    why: "role reassignment",
  },
];

export interface SuspicionReport {
  suspicious: boolean;
  reasons: string[];
}

export function detectSuspicious(text: string): SuspicionReport {
  const reasons = SUSPICIOUS.filter((p) => p.re.test(text)).map((p) => p.why);
  return { suspicious: reasons.length > 0, reasons };
}

// --- crypto fast-path allow ---

const CRYPTO_KEYWORDS =
  /\b(swap|trade|buy|sell|token|wallet|usdc|eth|weth|base|x402|acp|risk|limit|cap|allowance|permission|revoke|balance|price|whale|rug|onchain|on-chain|spend|daily|gas|slippage|dex|liquidity)\b/i;

export function looksCrypto(text: string): boolean {
  return CRYPTO_KEYWORDS.test(text);
}

/** Heuristic kept for callers that don't have a parsed intent. */
const ACTION_HINTS =
  /\b(swap|trade|buy|sell|send|pay|transfer|rebalance|purchase|hire|acp job|grant|revoke)\b/i;

export function looksLikeActionRequest(text: string): boolean {
  return ACTION_HINTS.test(text);
}

// --- URL sanitisation on every reply ---

const TRUSTED_HOSTS = [
  "basescan.org",
  "sepolia.basescan.org",
  "base.org",
  "coinbase.com",
  "cdp.coinbase.com",
  "etherscan.io",
  "sepolia.etherscan.io",
  "virtuals.io",
  "sibyllabs.org",
  "docs.sibyllabs.org",
  "t.me",
  "telegram.org",
  "github.com",
];

function hostAllowed(host: string, extra: readonly string[]): boolean {
  const h = host.toLowerCase();
  return [...TRUSTED_HOSTS, ...extra].some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;

/** Replace any URL not on the trusted-host allowlist with `[link removed]`. */
export function sanitizeUrls(text: string, extraAllowed: readonly string[] = []): string {
  return text.replace(URL_RE, (url) => {
    try {
      return hostAllowed(new URL(url).hostname, extraAllowed) ? url : "[link removed]";
    } catch {
      return "[link removed]";
    }
  });
}

// --- user-input wrapping ---

export function wrapUserInput(text: string): string {
  return `<user_input>\n${text}\n</user_input>`;
}

// --- external data validation ---

export interface ValidatedExternalData {
  /** Safe to hand to the LLM / show the user. Wrapped and length-capped. */
  safe: string;
  flagged: boolean;
  reasons: string[];
}

const MAX_EXTERNAL_CHARS = 8000;

/**
 * The one explicit step between an external payload (x402 response, ACP
 * counterparty output, price feed) and anything that acts on it. Strips control
 * characters, neutralises injection, caps length, and wraps the result so the LLM
 * treats it as data.
 */
export function validateExternalData(
  raw: unknown,
  sourceLabel = "external",
): ValidatedExternalData {
  let text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  const reasons: string[] = [];

  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  const injection = screenUserInput(text);
  if (!injection.ok) {
    reasons.push(injection.reason ?? "injection");
    text = text.replace(
      /\b(ignore|disregard|forget|override|you are now|system prompt|jailbreak)\b/gi,
      "[redacted]",
    );
  }

  const suspicion = detectSuspicious(text);
  if (suspicion.suspicious) reasons.push(...suspicion.reasons);

  if (text.length > MAX_EXTERNAL_CHARS) {
    text = `${text.slice(0, MAX_EXTERNAL_CHARS)}…[truncated]`;
    reasons.push("over length cap");
  }

  return {
    safe: `<untrusted_data source="${sourceLabel}">\n${text}\n</untrusted_data>`,
    flagged: reasons.length > 0,
    reasons,
  };
}
