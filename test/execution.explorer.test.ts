import { describe, expect, test } from "bun:test";

import { StubAcpProvider } from "../src/acp/stub.ts";
import { readFileSync } from "node:fs";

import { addressUrl, isTxHash, txLink, txUrl } from "../src/execution/explorer.ts";
import { mdToHtml } from "../src/telegram/gateway.ts";

/**
 * A receipt is the message that tells someone their money moved, and the link on it is
 * the only part they can check. Every settlement path has a placeholder it falls back
 * to when it cannot read a hash — x402 when the facilitator omits the payment-response
 * header, ACP because escrow settles inside the SDK — and that placeholder used to be
 * pasted into a URL, producing `https://basescan.org/tx/0x` on a message claiming a
 * spend had succeeded. Saying nothing is strictly better than that.
 */

const REAL = `0x${"a".repeat(64)}`;

describe("what counts as a transaction", () => {
  test("a 32-byte hex hash does", () => {
    expect(isTxHash(REAL)).toBe(true);
    expect(isTxHash(`0x${"A1b2".repeat(16)}`)).toBe(true);
  });

  test("the placeholder every settlement path falls back to does not", () => {
    expect(isTxHash("0x")).toBe(false);
  });

  test("nothing malformed does", () => {
    for (const bad of [
      "",
      "0x123",
      `0x${"a".repeat(63)}`,
      `0x${"a".repeat(65)}`,
      `0x${"z".repeat(64)}`,
      REAL.slice(2),
    ]) {
      expect(isTxHash(bad), `${bad} should not be a tx hash`).toBe(false);
    }
    expect(isTxHash(null)).toBe(false);
    expect(isTxHash(undefined)).toBe(false);
  });
});

describe("the link a receipt ends with", () => {
  test("a real hash becomes a labelled markdown link, on the right network", () => {
    expect(txLink(REAL, "base")).toBe(`[View on Basescan](https://basescan.org/tx/${REAL})`);
    expect(txLink(REAL, "base-sepolia")).toBe(
      `[View on Basescan](https://sepolia.basescan.org/tx/${REAL})`,
    );
  });

  /** The hash itself never reaches the reader — that is the point of the label. */
  test("the 66-character hash is in the href and nowhere else", () => {
    const link = txLink(REAL, "base", "View the swap");
    expect(link).toBe(`[View the swap](https://basescan.org/tx/${REAL})`);
    expect(link.slice(0, link.indexOf("]"))).not.toContain(REAL);
  });

  test("a caller can name what the transaction was", () => {
    expect(txLink(REAL, "base", "View the escrow transaction")).toStartWith(
      "[View the escrow transaction](",
    );
  });

  /** The whole point: no link at all, rather than a link to nothing. */
  test("a placeholder or missing hash produces nothing to join into a message", () => {
    expect(txLink("0x", "base")).toBe("");
    expect(txLink("0x", "base", "View the swap")).toBe("");
    expect(txLink(undefined, "base")).toBe("");
    expect(txLink(null, "base")).toBe("");
    // …and nothing is what `.filter(Boolean)` drops, so no stray label or space lands
    // in the message either.
    expect([`Paid $0.05 for "x".`, txLink("0x", "base")].filter(Boolean).join(" ")).toBe(
      'Paid $0.05 for "x".',
    );
  });

  /**
   * Telegram only formats a message sent with `parse_mode`. A markdown link in one
   * sent plain reaches the user as literal brackets and a naked URL — worse than the
   * bare link it replaced.
   */
  test("Telegram turns it into an anchor, and sends receipts rendered", () => {
    expect(mdToHtml(txLink(REAL, "base", "View the swap"))).toBe(
      `<a href="https://basescan.org/tx/${REAL}">View the swap</a>`,
    );
    const gateway = readFileSync("src/telegram/gateway.ts", "utf8");
    // Announcements carry the same receipt as the conversation, so they render too.
    expect(gateway).toMatch(/sendMessage\(accountId, render\(text\)/);
  });
});

test("explorer hosts are the Base ones", () => {
  expect(txUrl(REAL, "base")).toStartWith("https://basescan.org/tx/");
  expect(addressUrl(`0x${"1".repeat(40)}`, "base-sepolia")).toStartWith(
    "https://sepolia.basescan.org/address/",
  );
});

/**
 * The simulated counterparty used to return a well-formed sha256 in `txHash`. That was
 * inert while the hash only reached the ledger; once receipts started linking hashes,
 * it would have rendered a confident Basescan link to a transaction that never existed.
 */
test("the ACP simulation reports no transaction, because it makes none", async () => {
  const result = await new StubAcpProvider().hire(null, {
    jobType: "token_risk",
    subject: "PEPE",
    maxUsd: 0.5,
  });
  expect(result.settled).toBe(true);
  expect(result.txHash).toBeUndefined();
  expect(txLink(result.txHash, "base")).toBe("");
});
