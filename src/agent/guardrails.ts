/**
 * Input guardrails. Adapted from Len3's `agent/src/security/guardrails.ts`.
 *
 * Phase 2 stub — only the obvious explicit-injection hard block is wired. Phase 3
 * adds suspicious-pattern detection, the crypto keyword fast-path, `sanitizeUrls`,
 * and `<user_input>` wrapping, and puts a `validateExternalData()` pass between any
 * price-feed / x402 / ACP payload and the executor.
 */

const EXPLICIT_INJECTION = [
  /\b(ignore|disregard|forget|override)\b[\s\w]*\b(previous|prior|earlier|above|all|any|your)\b[\s\w]*\b(instructions?|prompts?|rules?|context|directives?)\b/i,
  /\byou are now (a|an|the)\b/i,
  /\bsystem prompt\b\s*[:=]/i,
  /\bDAN\b.*\bjailbreak\b/i,
  /\bpretend (you are|to be)\b.*\b(no|without) (rules|restrictions|limits)\b/i,
];

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

export function screenUserInput(text: string): GuardVerdict {
  for (const pattern of EXPLICIT_INJECTION) {
    if (pattern.test(text)) {
      return { ok: false, reason: "explicit prompt-injection pattern" };
    }
  }
  return { ok: true };
}

/** Heuristic used by the router until Phase 3's intent parser replaces it. */
const ACTION_HINTS =
  /\b(swap|trade|buy|sell|send|pay|transfer|rebalance|purchase|hire|acp job|grant|revoke)\b/i;

export function looksLikeActionRequest(text: string): boolean {
  return ACTION_HINTS.test(text);
}
