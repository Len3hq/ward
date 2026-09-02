import type { AcpJobEntry } from "./schema.ts";

/**
 * Counterparty trust — derived, never stored.
 *
 * Adapted from Len3's x402 trust score (tier base + success-ratio weighting +
 * recency). Ward's inputs are the `trust_delta` values recorded on each resolved
 * ACP job, in roughly [-1, +1].
 *
 * The score is a recency-weighted exponential moving average over per-job
 * "goodness":
 *
 *   goodness_i = clamp01(0.5 + trust_delta_i / 2)      // -1 → 0.0, 0 → 0.5, +1 → 1.0
 *   score_0    = NEUTRAL_PRIOR                          // unproven counterparty
 *   score_i    = ALPHA * goodness_i + (1 - ALPHA) * score_{i-1}   // oldest → newest
 *
 * Properties: bounded [0, 1], starts neutral, monotonic in `trust_delta`, and the
 * most recent jobs dominate. Read before choosing a counterparty (Phase 6).
 */

export const NEUTRAL_PRIOR = 0.5;
export const ALPHA = 0.4;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `jobs` for a single counterparty. Order-independent input — sorted here by `ts`. */
export function computeTrustScore(jobs: readonly AcpJobEntry[]): number {
  if (jobs.length === 0) return NEUTRAL_PRIOR;

  const chronological = [...jobs].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  let score = NEUTRAL_PRIOR;
  for (const job of chronological) {
    const goodness = clamp01(0.5 + job.trust_delta / 2);
    score = ALPHA * goodness + (1 - ALPHA) * score;
  }

  return Math.round(score * 1000) / 1000;
}
