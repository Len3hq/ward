import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { markCopyable } from "../src/gateway/format.ts";
import { render } from "../src/telegram/gateway.ts";
import { initialize, writeWallet } from "../memory/index.ts";
import { performSpend } from "../src/execution/perform.ts";
import { hermeticSetup, hermeticTeardown, USER } from "./support.ts";
import { walletProvider } from "../src/wallet/index.ts";

/**
 * How a paid result reaches the chat.
 *
 * The purchase worked; the message did not. Production, verbatim:
 *
 *   Paid $0.001 for "Smart Money Positioning". https://basescan.org/tx/
 *   ```
 *   0x32271c07ce577c598c8ce1d7a4084317276a082b
 *   ```
 *   57f779053e039342621414d6
 *
 *   { "result": { "data": { "lookback_days": 3, "summaries": [] } } }
 *
 * A settlement link cut in half — the address formatter matched the first 40 hex of
 * a 64-hex tx hash — and the data itself dumped raw, with the one interesting fact
 * about it (the list was empty) left for the user to notice.
 */

const TX = "0x32271c07ce577c598c8ce1d7a4084317276a082b57f779053e039342621414d6";
const TX_URL = `https://basescan.org/tx/${TX}`;
const ADDRESS = "0xdEC85Eff491CFA70DB91B71B7D62a13994d01357";

describe("a transaction link survives formatting", () => {
  test("the hash is not chopped at 40 characters", () => {
    for (const style of ["inline", "block"] as const) {
      const out = markCopyable(`Paid $0.001. ${TX_URL}`, style);
      expect(out).toContain(TX_URL);
      expect(out).not.toContain("```\n0x32271c07ce577c598c8ce1d7a4084317276a082b");
    }
  });

  test("a bare tx hash is left whole too", () => {
    expect(markCopyable(`tx ${TX}`, "block")).toBe(`tx ${TX}`);
    expect(markCopyable(`tx ${TX}`, "inline")).toBe(`tx ${TX}`);
  });

  test("an address inside a URL is not reformatted", () => {
    const url = `https://basescan.org/address/${ADDRESS}`;
    expect(markCopyable(`See ${url}`, "block")).toBe(`See ${url}`);
    expect(markCopyable(`See ${url}`, "inline")).toBe(`See ${url}`);
  });

  test("but a loose address is still made copyable", () => {
    expect(render(`Your wallet ${ADDRESS} on base`)).toContain(`<code>${ADDRESS}</code>`);
    expect(markCopyable(`Your wallet:\n${ADDRESS}`, "block")).toContain("```\n" + ADDRESS);
  });
});

describe("the data the user paid for", () => {
  beforeEach(async () => {
    await hermeticSetup();
    await initialize(USER, {
      risk_label: "moderate",
      per_action_limit_usd: 5,
      daily_limit_usd: 12,
    });
    await writeWallet(USER, {
      account_key: USER,
      smart_account: `0x${"1".repeat(40)}`,
      agent_spender: `0x${"2".repeat(40)}`,
      spend_permission: {
        token: "USDC",
        allowance_usd: 12,
        period_seconds: 86_400,
        granted_tx: "0xabc",
        status: "active",
      },
    });
  });
  afterEach(hermeticTeardown);

  const buy = async (data: unknown) => {
    const provider = walletProvider();
    const original = provider.payX402.bind(provider);
    provider.payX402 = async () => ({ data, txHash: TX, amountUsd: 0.001 });
    try {
      return await performSpend({
        userId: USER,
        actionType: "x402_data_purchase",
        amountUsd: 0.001,
        idempotencyKey: `p-${Math.random()}`,
        endpoint: {
          name: "Smart Money Positioning",
          url: "https://example.test/x402/smart-money",
          method: "POST",
          cost_usd: 0.001,
        },
      });
    } finally {
      provider.payX402 = original;
    }
  };

  test("arrives fenced, so both channels render it as data", async () => {
    const outcome = await buy({ result: { data: { summaries: ["ETH is up"] } } });
    expect(outcome.message).toContain("```json");
    expect(outcome.message).toContain("ETH is up");
  });

  test("names a field that came back empty, rather than leaving it to be noticed", async () => {
    const outcome = await buy({ result: { data: { lookback_days: 3, summaries: [] } } });
    expect(outcome.message).toContain("`summaries` came back empty");
    // The payload is still shown — the note is an annotation, not a replacement.
    expect(outcome.message).toContain("lookback_days");
  });

  test("says so plainly when there is nothing at all", async () => {
    const outcome = await buy({ result: { data: {} } });
    expect(outcome.message).toContain("no data for that request");
    expect(outcome.message).toContain("the payment settled");
    expect(outcome.message).not.toContain("```json");
  });

  test("a plain-text answer is passed through, not wrapped in braces", async () => {
    const outcome = await buy("Smart money rotated into ETH this week.");
    expect(outcome.message).toContain("Smart money rotated into ETH");
    expect(outcome.message).not.toContain("```json");
  });
});
