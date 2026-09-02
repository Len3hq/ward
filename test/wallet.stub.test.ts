import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetWalletProvider, walletProvider } from "../src/wallet/index.ts";

const TG = "111222333";

beforeEach(() => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  resetWalletProvider();
});

afterEach(() => resetWalletProvider());

describe("StubWalletProvider", () => {
  test("selected when no CDP keys are set", () => {
    expect(walletProvider().kind).toBe("stub");
  });

  test("connect returns stable per-user + shared spender addresses", async () => {
    const p = walletProvider();
    const a = await p.connect(TG);
    const b = await p.connect(TG);
    expect(a).toEqual(b);
    expect(a.smartAccount).toMatch(/^0x[0-9a-f]{40}$/);
    const other = await p.connect("999");
    expect(other.smartAccount).not.toBe(a.smartAccount);
    expect(other.agentSpender).toBe(a.agentSpender); // shared
  });

  test("grant → read → revoke lifecycle", async () => {
    const p = walletProvider();
    expect(await p.readSpendPermission(TG)).toBeNull();

    const granted = await p.grantSpendPermission(TG, 100, 1);
    expect(granted).toMatchObject({ status: "active", allowanceUsd: 100, periodSeconds: 86_400 });
    expect(granted.grantedTx).toMatch(/^0x/);

    expect(await p.readSpendPermission(TG)).toMatchObject({ status: "active", allowanceUsd: 100 });

    const { txHash } = await p.revokeSpendPermission(TG);
    expect(txHash).toMatch(/^0x/);
    expect((await p.readSpendPermission(TG))?.status).toBe("revoked");
  });

  test("grant honours a custom allowance", async () => {
    const p = walletProvider();
    expect((await p.grantSpendPermission(TG, 25, 1)).allowanceUsd).toBe(25);
  });
});
