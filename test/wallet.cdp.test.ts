import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { isGasShortfall } from "../src/agent/nodes/wallet.ts";
import { cdpAccountName, isRateLimited, withRpcRetry } from "../src/wallet/cdp.ts";
import { resetWalletProvider, walletProvider } from "../src/wallet/index.ts";

/**
 * Pure, always runs. `connect my wallet` failed in production with a CDP 400 —
 * `ward-owner-ward_<26-char ULID>` is 42 characters and contains an underscore,
 * where CDP allows 2-36 of `[a-zA-Z0-9-]`.
 */
describe("cdpAccountName", () => {
  const CDP_NAME = /^[a-zA-Z0-9-]{2,36}$/;
  const principal = "ward_01K5ZQ8ABCDEFGHJKMNPQRSTVW";

  test("a Ward principal produces a name CDP accepts", () => {
    expect(cdpAccountName("owner", principal)).toMatch(CDP_NAME);
    expect(cdpAccountName("user", principal)).toMatch(CDP_NAME);
  });

  test("owner and user are different accounts", () => {
    expect(cdpAccountName("owner", principal)).not.toBe(cdpAccountName("user", principal));
  });

  test("distinct principals never collide", () => {
    const other = "ward_01K5ZQ8ABCDEFGHJKMNPQRSTVX";
    expect(cdpAccountName("user", principal)).not.toBe(cdpAccountName("user", other));
  });

  test("the same key always yields the same name — the address depends on it", () => {
    expect(cdpAccountName("user", principal)).toBe(cdpAccountName("user", principal));
  });

  /**
   * The one that would strand funds: a migrated record pins `account_key` to the
   * original Telegram id, which already fits, so its name must not be rewritten.
   */
  test("a legacy Telegram account key keeps the name it always had", () => {
    expect(cdpAccountName("owner", "700100200")).toBe("ward-owner-700100200");
    expect(cdpAccountName("user", "700100200")).toBe("ward-user-700100200");
  });

  test("an unexpected key shape still yields a legal, stable name", () => {
    const weird = "some/other::key with spaces and a very long tail indeed 1234567890";
    expect(cdpAccountName("user", weird)).toMatch(CDP_NAME);
    expect(cdpAccountName("user", weird)).toBe(cdpAccountName("user", weird));
  });
});

/**
 * Only a gas shortfall gets the friendly "fund the account" reply; everything else
 * must keep propagating, so a real bug is never disguised as a funding problem.
 */
describe("isGasShortfall", () => {
  test("matches the CDP precheck failure a freshly generated account hits", () => {
    const real = new Error(
      "failed to send user operation: insufficient balance to perform useroperation: " +
        "precheck failed: sender balance and deposit together is 0 but must be at least 4725796812000",
    );
    expect(isGasShortfall(real)).toBe(true);
  });

  test("does not swallow unrelated failures", () => {
    expect(isGasShortfall(new Error("no active spend permission to revoke"))).toBe(false);
    expect(isGasShortfall(new Error("unknown token FOO on base"))).toBe(false);
    expect(isGasShortfall(new Error("request body has an error: doesn't match schema"))).toBe(
      false,
    );
  });

  test("survives a non-Error throw", () => {
    expect(isGasShortfall("precheck failed")).toBe(true);
    expect(isGasShortfall(undefined)).toBe(false);
  });
});

/**
 * Live check against a real CDP project. Opt-in: needs `CDP_API_KEY_ID`,
 * `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` **and** `WARD_CDP_TEST=1`. Skipped
 * otherwise so `bun test` stays green without CDP access. Uses a throwaway
 * Telegram id so it never touches a real user's accounts.
 *
 * Run: `WARD_CDP_TEST=1 bun test test/wallet.cdp.test.ts`
 * (set `BASE_NETWORK=base-sepolia`; fund the smart account with test USDC first.)
 */
const enabled =
  process.env.WARD_CDP_TEST === "1" &&
  !!process.env.CDP_API_KEY_ID &&
  !!process.env.CDP_API_KEY_SECRET &&
  !!process.env.CDP_WALLET_SECRET;

const TG = `test-${Date.now()}`;

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN ??= "test-token";
  resetWalletProvider();
});
afterAll(() => resetWalletProvider());

describe.skipIf(!enabled)("CdpWalletProvider (live)", () => {
  test("selects the CDP provider on Base Sepolia", () => {
    expect(walletProvider().kind).toBe("cdp");
  });

  test("connect creates a smart account and a shared spender", async () => {
    const wallet = await walletProvider().connect(TG);
    expect(wallet.smartAccount).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.agentSpender).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("grant → read → revoke a $1 spend permission", async () => {
    const provider = walletProvider();
    const granted = await provider.grantSpendPermission(TG, 1, 1);
    expect(granted.status).toBe("active");
    expect(granted.allowanceUsd).toBe(1);

    const live = await provider.readSpendPermission(TG);
    expect(live?.status).toBe("active");

    await provider.revokeSpendPermission(TG);
    expect((await provider.readSpendPermission(TG))?.status).toBe("revoked");
  }, 120_000);
});

test.skipIf(enabled)("CDP live suite is skipped (set WARD_CDP_TEST=1 + CDP keys to run)", () => {
  expect(enabled).toBe(false);
});

/**
 * The failure this guards against, from production: a `hire an agent` job died with
 * viem's `RpcRequestError` — "RPC Request failed … Details: over rate limit" — on a
 * `balanceOf` against `https://mainnet.base.org`, mid-settlement, and the refund that
 * followed failed the same way ("refund of $0.01 failed — owed to user").
 *
 * Two things had to be true for that. The reads went to the free public endpoint
 * because `BASE_RPC_URL` was documented in `.env.example` but never read by
 * `loadConfig`; and viem does not retry Base's throttle, because it reports one as
 * JSON-RPC `-32016` in a 200 body, which matches none of the codes `shouldRetry`
 * knows (-32005, -32603, 429) nor any HTTP status.
 */
describe("isRateLimited", () => {
  test("Base's public gateway throttle — the code viem does not retry", () => {
    expect(isRateLimited({ code: -32016, message: "over rate limit" })).toBe(true);
  });

  test("the throttle shapes other providers use", () => {
    expect(isRateLimited({ code: -32005 })).toBe(true);
    expect(isRateLimited({ code: 429 })).toBe(true);
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited(new Error("429 Too Many Requests"))).toBe(true);
  });

  /** Matching on message text as well as code, since the wrapper is what callers see. */
  test("a wrapped viem error still reads as a throttle", () => {
    const wrapped = new Error(
      "RPC Request failed.\nURL: https://mainnet.base.org\nDetails: over rate limit",
    );
    expect(isRateLimited(wrapped)).toBe(true);
  });

  /**
   * The half that matters most. A revert is a real answer about where the money is —
   * retrying it would waste the settle budget and could turn a clean failure into an
   * ambiguous one.
   */
  test("a revert is not a throttle", () => {
    expect(isRateLimited(new Error("ERC20: transfer amount exceeds balance"))).toBe(false);
    expect(isRateLimited({ code: -32000, message: "execution reverted" })).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });
});

describe("withRpcRetry", () => {
  test("a throttled read is retried and its answer returned", async () => {
    let calls = 0;
    const value = await withRpcRetry(async () => {
      calls++;
      if (calls < 3) throw { code: -32016, message: "over rate limit" };
      return 0.73;
    });
    expect(value).toBe(0.73);
    expect(calls).toBe(3);
  });

  test("a revert fails immediately — no retry, no delay", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(async () => {
        calls++;
        throw new Error("execution reverted");
      }),
    ).rejects.toThrow("execution reverted");
    expect(calls).toBe(1);
  });

  /** An endpoint that is throttling us for good must still surface, not hang forever. */
  test("a persistent throttle gives up and reports the throttle", async () => {
    let calls = 0;
    await expect(
      withRpcRetry(async () => {
        calls++;
        throw new Error("over rate limit");
      }),
    ).rejects.toThrow("over rate limit");
    expect(calls).toBe(4);
  });
});
