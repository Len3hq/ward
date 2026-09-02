import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resetWalletProvider, walletProvider } from "../src/wallet/index.ts";

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
