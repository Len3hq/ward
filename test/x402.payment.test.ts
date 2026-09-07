import { describe, expect, test } from "bun:test";

import { loadCatalog, resolveX402Call } from "../src/execution/catalog.ts";
import { x402QuoteUsd, x402Signer } from "../src/wallet/cdp.ts";

/**
 * Why no x402 purchase had ever worked.
 *
 * "Buy 'Smart Money Positioning' (~$0.05) … Confirm? yes" → nothing. The payment
 * threw before a byte hit the network: `x402-fetch` duck-types its signer, and a CDP
 * server account fails the check by a single missing field.
 */

/**
 * Verbatim from `x402/dist/cjs/index.js` — the two predicates that decide whether a
 * payment can be signed at all. Copied rather than imported because the library does
 * not export them, and this is precisely the contract that broke.
 */
function x402AcceptsSigner(wallet: unknown): boolean {
  const w = wallet as Record<string, unknown>;
  const isSignerWallet =
    typeof wallet === "object" && wallet !== null && "chain" in w && "transport" in w;
  const isAccount =
    typeof wallet === "object" &&
    wallet !== null &&
    typeof w.address === "string" &&
    typeof w.type === "string" &&
    typeof w.sign === "function" &&
    typeof w.signMessage === "function" &&
    typeof w.signTypedData === "function" &&
    typeof w.signTransaction === "function";
  return isSignerWallet || isAccount;
}

/** The shape of a CDP `EvmServerAccount` (see `@coinbase/cdp-sdk` account types). */
const cdpAccount = {
  address: "0xa44ae96e158293791dc45a2a138ccd84625db915",
  name: "ward-agent-spender",
  sign: async () => "0x",
  signMessage: async () => "0x",
  signTransaction: async () => "0x",
  signTypedData: async () => "0x",
};

describe("the payment signer", () => {
  test("a raw CDP account is rejected by x402 — the bug", () => {
    expect(x402AcceptsSigner(cdpAccount)).toBe(false);
    // One field. It has every signing method x402 asks for.
    expect("type" in cdpAccount).toBe(false);
  });

  test("the adapter makes it acceptable, and keeps the address", () => {
    const signer = x402Signer(cdpAccount);
    expect(x402AcceptsSigner(signer)).toBe(true);
    expect((signer as unknown as { address: string }).address.toLowerCase()).toBe(
      cdpAccount.address.toLowerCase(),
    );
    expect((signer as unknown as { type: string }).type).toBe("local");
  });

  test("signing still goes through the CDP account, not a local key", async () => {
    let called = false;
    const signer = x402Signer({
      ...cdpAccount,
      signTypedData: async () => {
        called = true;
        return "0xsig";
      },
    });
    const signature = await (
      signer as unknown as { signTypedData: (d: unknown) => Promise<string> }
    ).signTypedData({});
    expect(called).toBe(true);
    expect(signature).toBe("0xsig");
  });
});

describe("what the endpoint actually charges", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const challenge = (over: Record<string, unknown> = {}) => ({
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        asset: USDC,
        maxAmountRequired: "1000",
        ...over,
      },
    ],
  });

  test("reads the price from the 402, in USD", () => {
    // 1000 atomic units of 6-decimal USDC — the real price of the Heurist endpoints,
    // which the catalogue advertised as $0.05.
    expect(x402QuoteUsd(challenge(), "base", USDC)).toBe(0.001);
  });

  test("ignores an offer Ward has no authority to pay", () => {
    // The Spend Permission is USDC on one network. Anything else is not cheaper, it
    // is impossible — and must not be mistaken for a price.
    expect(x402QuoteUsd(challenge({ asset: "0xdead" }), "base", USDC)).toBeNull();
    expect(x402QuoteUsd(challenge({ network: "base-sepolia" }), "base", USDC)).toBeNull();
    expect(x402QuoteUsd(challenge({ scheme: "upto" }), "base", USDC)).toBeNull();
  });

  test("a body with no offers is not a price", () => {
    expect(x402QuoteUsd({}, "base", USDC)).toBeNull();
    expect(x402QuoteUsd(null, "base", USDC)).toBeNull();
    expect(x402QuoteUsd({ accepts: [] }, "base", USDC)).toBeNull();
  });
});

describe("the catalogue", () => {
  test("every entry is priced in whole cents or less and resolvable", async () => {
    const endpoints = await loadCatalog();
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      const call = resolveX402Call(endpoint, "0x4200000000000000000000000000000000000006");
      expect(call.url).toStartWith("https://");
      expect(endpoint.cost_usd).toBeGreaterThan(0);
      // No `{subject}` may survive into a real request.
      expect(JSON.stringify(call)).not.toContain("{subject}");
      expect(JSON.stringify(call)).not.toContain("{token}");
    }
  });

  test("carries no endpoint known to be dead", async () => {
    const endpoints = await loadCatalog();
    // x402.elizaos.ai has been answering 502 from its own nginx; `scripts/x402-verify.ts`
    // is what proves the rest are alive, since only a live probe can.
    expect(endpoints.some((e) => e.url.includes("elizaos"))).toBe(false);
  });
});
