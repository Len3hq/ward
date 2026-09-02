import { createHash } from "node:crypto";

import type { Hex, SpendPermissionState, UserWallet, WalletProvider } from "./provider.ts";

/**
 * Deterministic in-memory wallet provider for tests and no-key dev. Fake but
 * stable addresses; permission state lives in a `Map`. **Not the judged path** —
 * the real Spend Permission is granted by `wallet/cdp.ts`.
 */
export class StubWalletProvider implements WalletProvider {
  readonly kind = "stub" as const;
  #network: "base" | "base-sepolia";
  #permissions = new Map<string, SpendPermissionState>();

  constructor(network: "base" | "base-sepolia") {
    this.#network = network;
  }

  network(): "base" | "base-sepolia" {
    return this.#network;
  }

  async connect(tgId: string): Promise<UserWallet> {
    return {
      smartAccount: fakeAddress(`ward-user-${tgId}`),
      agentSpender: fakeAddress("ward-agent-spender"),
    };
  }

  async grantSpendPermission(
    tgId: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState> {
    const state: SpendPermissionState = {
      status: "active",
      allowanceUsd,
      periodSeconds: Math.round(periodDays * 86_400),
      permissionHash: fakeHash(`perm-${tgId}-${allowanceUsd}`),
      grantedTx: fakeHash(`grant-${tgId}-${Date.now()}`),
    };
    this.#permissions.set(tgId, state);
    return state;
  }

  async readSpendPermission(tgId: string): Promise<SpendPermissionState | null> {
    return this.#permissions.get(tgId) ?? null;
  }

  async revokeSpendPermission(tgId: string): Promise<{ txHash: string }> {
    const current = this.#permissions.get(tgId);
    if (current) this.#permissions.set(tgId, { ...current, status: "revoked" });
    return { txHash: fakeHash(`revoke-${tgId}-${Date.now()}`) };
  }

  async usdcBalanceUsd(): Promise<number> {
    return 1000; // plenty, for the demo
  }
}

function fakeAddress(seed: string): Hex {
  return `0x${createHash("sha256").update(seed).digest("hex").slice(0, 40)}` as Hex;
}

function fakeHash(seed: string): string {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}
