import { describe, expect, test } from "bun:test";

import { preview } from "../src/execution/perform.ts";

/**
 * What the user gets for their money, as something they can read.
 *
 * Every Nansen endpoint answers `{ data: [...], pagination: {...} }`, and the screener
 * returns twenty rows of twenty-three fields. Pretty-printed JSON clipped at 1200
 * characters showed two rows of punctuation and a "…" — the user paid a cent for a
 * wall of braces.
 */

/** Trimmed from Nansen's published output schemas — the field names, verbatim. */
const screenerRow = {
  chain: "base",
  token_address: "0x4200000000000000000000000000000000000006",
  token_symbol: "AERO",
  token_age_days: 412,
  market_cap_usd: 1234567.89,
  liquidity: 340123.4,
  price_usd: 0.8512,
  price_change: 0.0342,
};
const holderRow = {
  address: "0x1111111111111111111111111111111111111111",
  address_label: "Coinbase 2",
  token_amount: 12500000,
  ownership_percentage: 0.0812,
  value_usd: 10640000,
  balance_change_24h: -12000,
};

describe("rendering a table of results", () => {
  test("rows become lines, not JSON", () => {
    const out = preview({ data: [screenerRow], pagination: {} });
    expect(out).not.toContain("```json");
    expect(out).not.toContain('"token_symbol"');
    expect(out).toContain("AERO");
    expect(out).toContain("1 result:");
  });

  test("long lists are capped and say what was left out", () => {
    const out = preview({ data: Array.from({ length: 20 }, () => screenerRow), pagination: {} });
    expect(out).toContain("20 results:");
    expect(out).toContain("…and 15 more.");
    expect(out.split("\n").filter((l) => /^\d+\. /.test(l))).toHaveLength(5);
  });

  test("identifying fields lead the row", () => {
    const out = preview({ data: [screenerRow], pagination: {} });
    expect(out).toMatch(/1\. .*AERO/);
    expect(out).toContain("0x4200…0006"); // 42 characters is not an identifier a person reads
  });

  test("an envelope this does not recognise still falls back to JSON", () => {
    const out = preview({ risk_score: 82, flags: ["mint authority"] });
    expect(out).toContain("```json");
  });

  test("an empty payload says so rather than printing an empty table", () => {
    expect(preview({ data: [], pagination: {} })).toContain("no data");
  });
});

describe("units come from the field name, never the value", () => {
  /**
   * The bug this guards: deciding "small enough to be a ratio" by magnitude rendered
   * `balance_change_24h` as `-12.0K` in one row and `0.00%` in the next — one column,
   * two units, down the same page.
   */
  test("the same field keeps its unit whatever the number is", () => {
    const out = preview({
      data: [holderRow, { ...holderRow, balance_change_24h: 0, address_label: null }],
      pagination: {},
    });
    expect(out).toContain("balance change 24h -12.0K");
    expect(out).toContain("balance change 24h 0");
    expect(out).not.toContain("balance change 24h 0.00%");
  });

  test("dollars only where the name says dollars", () => {
    const out = preview({ data: [holderRow], pagination: {} });
    expect(out).toContain("value usd $10.64M");
    // A quantity of tokens is not a quantity of dollars.
    expect(out).toContain("token amount 12.50M");
    expect(out).not.toContain("token amount $12.50M");
  });

  test("counts and durations are integers", () => {
    const out = preview({ data: [{ ...screenerRow, nof_buyers: 812 }], pagination: {} });
    expect(out).toContain("token age days 412");
    expect(out).not.toContain("412.00");
  });

  test("a change is signed; a share is not", () => {
    const out = preview({
      data: [{ token_symbol: "AERO", price_change: 0.0342, ownership_percentage: 0.0812 }],
      pagination: {},
    });
    expect(out).toContain("price change +3.42%");
    expect(out).toContain("ownership percentage 8.12%");
    expect(out).not.toContain("ownership percentage +8.12%");
  });

  test("a row is trimmed to what fits a chat message", () => {
    // Nansen returns up to 23 fields per row; a phone shows a handful.
    const wide = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [`field_${i}`, i + 1]));
    const line = preview({ data: [{ token_symbol: "AERO", ...wide }], pagination: {} })
      .split("\n")
      .find((l) => l.startsWith("   "))!;
    expect(line.split(" · ")).toHaveLength(5);
  });

  test("empty and null fields are dropped rather than printed", () => {
    const out = preview({
      data: [{ token_symbol: "AERO", note: null, tags: [], blank: "" }],
      pagination: {},
    });
    expect(out).toContain("AERO");
    expect(out).not.toContain("note");
    expect(out).not.toContain("blank");
  });
});
