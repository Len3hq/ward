import { describe, expect, test } from "bun:test";

import type { AcpJobEntry } from "../memory/schema.ts";
import { computeTrustScore, NEUTRAL_PRIOR } from "../memory/trust.ts";

function job(ts: string, trust_delta: number): AcpJobEntry {
  return {
    ts,
    counterparty_id: "agent://acme",
    job_type: "token_risk",
    outcome_summary: "n/a",
    trust_delta,
  };
}

describe("computeTrustScore", () => {
  test("no history → neutral prior", () => {
    expect(computeTrustScore([])).toBe(NEUTRAL_PRIOR);
  });

  test("a single neutral job stays at the prior", () => {
    expect(computeTrustScore([job("2026-09-01T00:00:00Z", 0)])).toBe(0.5);
  });

  test("positive deltas raise the score, negative deltas lower it", () => {
    const good = computeTrustScore([
      job("2026-09-01T00:00:00Z", 0.5),
      job("2026-09-02T00:00:00Z", 0.8),
    ]);
    const bad = computeTrustScore([
      job("2026-09-01T00:00:00Z", -0.5),
      job("2026-09-02T00:00:00Z", -0.8),
    ]);
    expect(good).toBeGreaterThan(0.5);
    expect(bad).toBeLessThan(0.5);
  });

  test("stays within [0, 1] under extreme input", () => {
    const maxed = computeTrustScore(
      Array.from({ length: 20 }, (_, i) =>
        job(`2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`, 1),
      ),
    );
    const floored = computeTrustScore(
      Array.from({ length: 20 }, (_, i) =>
        job(`2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`, -1),
      ),
    );
    expect(maxed).toBeLessThanOrEqual(1);
    expect(maxed).toBeGreaterThan(0.9);
    expect(floored).toBeGreaterThanOrEqual(0);
    expect(floored).toBeLessThan(0.1);
  });

  test("order-independent: input is sorted by ts internally", () => {
    const forward = computeTrustScore([
      job("2026-09-01T00:00:00Z", -0.9),
      job("2026-09-02T00:00:00Z", 0.9),
    ]);
    const shuffled = computeTrustScore([
      job("2026-09-02T00:00:00Z", 0.9),
      job("2026-09-01T00:00:00Z", -0.9),
    ]);
    expect(forward).toBe(shuffled);
  });

  test("recent jobs dominate: a late recovery outweighs an early failure", () => {
    const score = computeTrustScore([
      job("2026-09-01T00:00:00Z", -0.9),
      job("2026-09-05T00:00:00Z", 0.9),
      job("2026-09-09T00:00:00Z", 0.9),
    ]);
    expect(score).toBeGreaterThan(0.5);
  });
});
