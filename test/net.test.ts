import { describe, expect, test } from "bun:test";

import { isCoinbaseHost } from "../src/net.ts";

describe("isCoinbaseHost", () => {
  test("matches Coinbase / CDP hosts", () => {
    for (const url of [
      "https://api.cdp.coinbase.com/platform/v2/evm/accounts",
      "https://api.coinbase.com/v2/x402",
      "https://x402.coinbase.com/facilitator",
      "https://COINBASE.COM/",
    ]) {
      expect(isCoinbaseHost(url)).toBe(true);
    }
  });

  test("leaves everything else alone", () => {
    for (const url of [
      "https://api.openai.com/v1/chat/completions",
      "https://api.telegram.org/bot123/getMe",
      "https://evil-coinbase.com.attacker.net/",
      "https://notcoinbase.com/",
      "not a url",
    ]) {
      expect(isCoinbaseHost(url)).toBe(false);
    }
  });

  test("accepts URL and Request inputs", () => {
    expect(isCoinbaseHost(new URL("https://api.cdp.coinbase.com/x"))).toBe(true);
    expect(isCoinbaseHost(new Request("https://api.openai.com/x"))).toBe(false);
  });
});
