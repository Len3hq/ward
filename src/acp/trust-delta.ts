import type { AcpJobResult } from "./provider.ts";

/**
 * Turns a resolved job into a `trust_delta` for `acp_job_history`.
 *
 * This is a **delivery + integrity** signal, not a correctness signal — whether
 * the risk call was actually right needs hindsight, which is recorded separately
 * (and pre-seeded for the demo, per the plan). Here:
 *
 *   did not settle        → -0.3   (took the job, didn't deliver)
 *   settled, flagged      → -0.4   (delivered junk / tried to inject)
 *   settled, thin         → -0.1   (delivered, but empty)
 *   settled, substantive  → +0.3
 */
export function jobTrustDelta(result: AcpJobResult, validationFlagged: boolean): number {
  if (!result.settled) return -0.3;
  if (validationFlagged) return -0.4;
  return hasSubstance(result.rawResult) ? 0.3 : -0.1;
}

function hasSubstance(raw: unknown): boolean {
  if (raw == null) return false;
  if (typeof raw === "string") return raw.trim().length > 20;
  if (typeof raw === "object") return Object.keys(raw).length >= 2;
  return true;
}
