import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { cdpAccountName } from "../src/wallet/cdp.ts";
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
