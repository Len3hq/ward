import { describe, expect, test } from "bun:test";

import {
  pickBaseToken,
  scoreToken,
  type DexPair,
  type GoPlusToken,
} from "../counterparty/score.ts";

/**
 * The counterparty sells a *reproducible* report — so the scorer is pinned here.
 * If these numbers change, `scorer_version` must change with them, or an old
 * report's `raw_sha256` no longer re-derives to the same score.
 */

const CLEAN: GoPlusToken = {
  is_open_source: "1",
  is_mintable: "0",
  owner_address: "0x0000000000000000000000000000000000000000",
  buy_tax: "0",
  sell_tax: "0",
  holder_count: "5000",
  holders: [{ percent: "0.05" }, { percent: "0.03" }],
  lp_holders: [{ is_locked: 1, percent: "0.9" }],
};

const score = (t: GoPlusToken) => scoreToken("0xabc", t, "{}");

describe("scoreToken", () => {
  test("a clean token scores low-risk with no flags", () => {
    const report = score(CLEAN);
    expect(report.risk_score).toBe(100);
    expect(report.band).toBe("low");
    expect(report.flags).toEqual([]);
  });

  test("a honeypot floors the score regardless of everything else", () => {
    const report = score({ ...CLEAN, is_honeypot: "1" });
    expect(report.risk_score).toBe(0);
    expect(report.band).toBe("high");
    expect(report.flags[0]).toContain("honeypot");
  });

  test("penalties stack and read worst-first", () => {
    const report = score({ ...CLEAN, is_mintable: "1", sell_tax: "0.25" });
    expect(report.risk_score).toBe(60); // 100 − 20 (mint) − 20 (sell tax)
    expect(report.band).toBe("low");
    expect(report.flags).toEqual(["mint authority is live", "sell tax over 10%"]);
  });

  test("holder concentration bands do not double-count", () => {
    expect(score({ ...CLEAN, holders: [{ percent: "0.5" }] }).flags).toEqual([
      "top-10 holders over 40%",
    ]);
    expect(score({ ...CLEAN, holders: [{ percent: "0.7" }] }).flags).toEqual([
      "top-10 holders over 60%",
    ]);
  });

  test("missing data is not treated as bad data", () => {
    // No holder_count, no lp_holders, no holders — an empty response must not
    // manufacture flags the source never supported.
    const report = score({ is_open_source: "1", owner_address: "" });
    expect(report.flags).toEqual([]);
    expect(report.risk_score).toBe(100);
  });

  test("ticker resolution takes the deepest Base pool, and only Base", () => {
    const pairs: DexPair[] = [
      {
        chainId: "ethereum",
        baseToken: { address: `0x${"1".repeat(40)}`, symbol: "PEPE" },
        liquidity: { usd: 9_000_000 },
      },
      {
        chainId: "base",
        baseToken: { address: `0x${"2".repeat(40)}`, symbol: "PEPE" },
        liquidity: { usd: 10_000 },
      },
      {
        chainId: "base",
        baseToken: { address: `0x${"3".repeat(40)}`, symbol: "PEPE" },
        liquidity: { usd: 250_000 },
      },
      {
        chainId: "base",
        baseToken: { address: `0x${"4".repeat(40)}`, symbol: "PEPECOIN" },
        liquidity: { usd: 999_999 },
      },
    ];
    // Not the richest pool overall (that one is on ethereum), and not a near-miss symbol.
    expect(pickBaseToken(pairs, "pepe")?.baseToken?.address).toBe(`0x${"3".repeat(40)}`);
  });

  test("an unresolvable ticker returns null rather than a wrong guess", () => {
    expect(pickBaseToken([], "PEPE")).toBeNull();
    expect(pickBaseToken([{ chainId: "base", baseToken: { symbol: "PEPE" } }], "PEPE")).toBeNull();
  });

  test("the report carries what makes it checkable", () => {
    const report = scoreToken("0xabc", CLEAN, '{"result":{}}');
    expect(report.sources[0]?.url).toContain("8453");
    expect(report.sources[0]?.raw_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.scorer_version).toBeTruthy();
    expect(report.scale).toContain("higher is safer");
  });

  test("a resolved ticker is disclosed, not hidden", () => {
    const report = scoreToken("PEPE", CLEAN, "{}", {
      address: "0xdef",
      how: 'ticker "PEPE" resolved to the deepest Base pool',
      source: { name: "dexscreener.search", url: "https://x", raw_sha256: "a".repeat(64) },
    });
    expect(report.subject).toBe("PEPE");
    expect(report.address).toBe("0xdef");
    expect(report.resolved_by).toContain("deepest Base pool");
    // Both the resolution and the security data are citable.
    expect(report.sources.map((s) => s.name)).toEqual([
      "dexscreener.search",
      "goplus.token_security",
    ]);
  });

  test("the shape satisfies Ward's substance check", () => {
    // `jobTrustDelta` scores an object with < 2 keys as a thin deliverable (-0.1).
    expect(Object.keys(score(CLEAN)).length).toBeGreaterThanOrEqual(2);
  });
});
