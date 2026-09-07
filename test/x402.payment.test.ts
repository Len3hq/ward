import { ExactEvmScheme } from "@x402/evm";
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";

import { loadCatalog, resolveX402Call } from "../src/execution/catalog.ts";
import { failureDetail, x402QuoteUsd, x402Signer } from "../src/wallet/cdp.ts";

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
  /**
   * The v1 duck-type above is kept as the record of what used to break, but it is no
   * longer the contract. `@x402/evm`'s `ClientEvmSigner` asks for `address` +
   * `signTypedData` and nothing else — the `type: "local"` field that a raw CDP
   * account lacked, and that `toAccount()` existed to bolt on, is not consulted.
   * A CDP server account satisfies v2 as it comes.
   */
  test("v2 asks for less than v1 did — the field that broke it is gone", () => {
    expect(x402AcceptsSigner(cdpAccount)).toBe(false); // would have failed v1
    const signer = x402Signer(cdpAccount) as unknown as Record<string, unknown>;
    expect(typeof signer.address).toBe("string");
    expect(typeof signer.signTypedData).toBe("function");
  });

  test("the adapter keeps the address", () => {
    const signer = x402Signer(cdpAccount) as unknown as { address: string };
    expect(signer.address.toLowerCase()).toBe(cdpAccount.address.toLowerCase());
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

  /**
   * The migration's load-bearing claim, proved rather than assumed: the NARROW
   * surface a CDP account exposes is enough to build a real v2 payload. The account
   * here is deliberately reduced to `address` + `signTypedData` — no `type`, no
   * `sign`, no `signMessage`, no `signTransaction`. Verified against Nansen's live
   * challenge during the migration; pinned here against a captured copy of it.
   */
  test("a CDP-shaped signer produces a signed v2 payload", async () => {
    const key = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
    const signer = x402Signer({
      address: key.address,
      signTypedData: (d: unknown) => key.signTypedData(d as never),
    });

    const payload = await new ExactEvmScheme(signer).createPaymentPayload(2, {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "50000",
      payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
      resource: "https://api.nansen.ai/api/v1/smart-money/holdings",
      description: "Get Smart Money Holdings Data",
      mimeType: "",
    } as never);

    expect((payload as { x402Version: number }).x402Version).toBe(2);
    expect(JSON.stringify(payload)).toMatch(/0x[0-9a-f]{120,}/i); // a real 65-byte signature
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

  /**
   * v2 renames both fields that matter: `maxAmountRequired` → `amount`, and the
   * network becomes a CAIP-2 id. Reading only v1 is what made the verify script
   * report Nansen as "no exact offer on base" while the endpoint was perfectly
   * payable — and would have made the payment path quote the catalogue estimate
   * instead of the real price.
   */
  describe("x402 v2 challenges", () => {
    /** Trimmed from Nansen's live 402 — the shape, verbatim. */
    const v2 = {
      x402Version: 2,
      resource: { url: "https://api.nansen.ai/api/v1/smart-money/netflow" },
      accepts: [
        { scheme: "exact", network: "eip155:8453", asset: USDC, amount: "50000" },
        { scheme: "exact", network: "eip155:56", asset: "0xcE24", amount: "50000000000000000" },
        { scheme: "exact", network: "solana:5eykt4", asset: "EPjFW", amount: "50000" },
      ],
    };

    test("reads the price from a v2 body", () => {
      expect(x402QuoteUsd(v2, "base", USDC)).toBe(0.05);
    });

    test("picks the Base/USDC offer out of a multi-chain challenge", () => {
      // BNB is listed first at a nominally larger number and Solana at the same one.
      // Neither is payable: the Spend Permission is USDC on Base and nothing else.
      const reordered = { ...v2, accepts: [...v2.accepts].reverse() };
      expect(x402QuoteUsd(reordered, "base", USDC)).toBe(0.05);
    });

    test("a v2 challenge that omits Base is not payable", () => {
      const noBase = { ...v2, accepts: v2.accepts.filter((a) => a.network !== "eip155:8453") };
      expect(x402QuoteUsd(noBase, "base", USDC)).toBeNull();
    });

    test("mainnet and sepolia are not interchangeable", () => {
      expect(x402QuoteUsd(v2, "base-sepolia", USDC)).toBeNull();
    });
  });
});

/**
 * A paid request that comes back 402 is the one failure that matters most, and the
 * reason is in its body. Throwing on the status alone discarded it: production logged
 * "the endpoint returned 402" and nothing else, so why a signed voucher was refused
 * could not be worked out from the logs at all.
 */
describe("why a paid request was refused", () => {
  const res = (body: string, type = "application/json") =>
    new Response(body, { status: 402, headers: { "content-type": type } });

  test("pulls x402's own reason out of the body", async () => {
    expect(await failureDetail(res('{"x402Version":2,"error":"invalid_payment_signature"}'))).toBe(
      "invalid_payment_signature",
    );
  });

  test("falls back to `message`, which is what Nansen uses", async () => {
    expect(await failureDetail(res('{"message":"settlement failed: insufficient balance"}'))).toBe(
      "settlement failed: insufficient balance",
    );
  });

  test("a non-JSON body is still better than nothing", async () => {
    expect(await failureDetail(res("Bad Gateway", "text/plain"))).toBe("Bad Gateway");
  });

  test("an empty body says nothing rather than inventing something", async () => {
    expect(await failureDetail(res(""))).toBe("");
  });

  test("it is trimmed — this reaches the user's chat", async () => {
    const detail = await failureDetail(res(JSON.stringify({ error: "x".repeat(500) })));
    expect(detail.length).toBeLessThanOrEqual(200);
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
