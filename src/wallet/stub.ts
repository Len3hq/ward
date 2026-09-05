import { createHash } from "node:crypto";

import type {
  Hex,
  SpendPermissionState,
  SwapRequest,
  SwapResult,
  UserWallet,
  WalletProvider,
  X402Request,
  X402Result,
} from "./provider.ts";

/** Rough USD → token display for the swap simulation. */
const APPROX_USD_PER_TOKEN: Record<string, number> = {
  ETH: 3400,
  WETH: 3400,
  CBETH: 3600,
  WBTC: 96_000,
  USDC: 1,
  USDT: 1,
  DAI: 1,
};

/**
 * Deterministic in-memory wallet provider for tests and no-key dev. Fake but
 * stable addresses; permission state lives in a `Map`. **Not the judged path** —
 * the real Spend Permission is granted by `wallet/cdp.ts`.
 */
export class StubWalletProvider implements WalletProvider {
  readonly kind = "stub" as const;
  #network: "base" | "base-sepolia";
  #permissions = new Map<string, SpendPermissionState>();

  /** Test observability: method names, in call order. A spend must never land here after a refusal. */
  readonly calls: string[] = [];

  constructor(network: "base" | "base-sepolia") {
    this.#network = network;
  }

  network(): "base" | "base-sepolia" {
    return this.#network;
  }

  async connect(accountKey: string): Promise<UserWallet> {
    return {
      smartAccount: fakeAddress(`ward-user-${accountKey}`),
      agentSpender: fakeAddress("ward-agent-spender"),
    };
  }

  async grantSpendPermission(
    accountKey: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState> {
    const state: SpendPermissionState = {
      status: "active",
      allowanceUsd,
      periodSeconds: Math.round(periodDays * 86_400),
      permissionHash: fakeHash(`perm-${accountKey}-${allowanceUsd}`),
      grantedTx: fakeHash(`grant-${accountKey}-${Date.now()}`),
    };
    this.#permissions.set(accountKey, state);
    return state;
  }

  async readSpendPermission(accountKey: string): Promise<SpendPermissionState | null> {
    return this.#permissions.get(accountKey) ?? null;
  }

  async revokeSpendPermission(accountKey: string): Promise<{ txHash: string }> {
    const current = this.#permissions.get(accountKey);
    if (current) this.#permissions.set(accountKey, { ...current, status: "revoked" });
    return { txHash: fakeHash(`revoke-${accountKey}-${Date.now()}`) };
  }

  async usdcBalanceUsd(): Promise<number> {
    return 1000; // plenty, for the demo
  }

  async payX402(accountKey: string, request: X402Request): Promise<X402Result> {
    this.calls.push("payX402");
    return {
      data: {
        simulated: true,
        endpoint: request.url,
        method: request.method,
        body: request.body ?? null,
        note: "stub provider — no real payment",
      },
      txHash: fakeHash(`x402-${accountKey}-${request.url}-${Date.now()}`),
      amountUsd: request.expectedUsd,
    };
  }

  async fundAgentFromUser(_accountKey: string, amountUsd: number): Promise<{ pulledUsd: number }> {
    this.calls.push("fundAgentFromUser");
    return { pulledUsd: amountUsd };
  }

  async transferUsdcFromSpender(to: Hex, amountUsd: number): Promise<{ txHash: string }> {
    this.calls.push("transferUsdcFromSpender");
    return { txHash: fakeHash(`transfer-${to}-${amountUsd}-${Date.now()}`) };
  }

  async refundUser(accountKey: string, amountUsd: number): Promise<{ txHash: string }> {
    this.calls.push("refundUser");
    return { txHash: fakeHash(`refund-${accountKey}-${amountUsd}-${Date.now()}`) };
  }

  async swap(accountKey: string, request: SwapRequest): Promise<SwapResult> {
    this.calls.push("swap");
    const price = APPROX_USD_PER_TOKEN[request.buySymbol.toUpperCase()] ?? 1;
    const received = request.amountUsd / price;
    return {
      txHash: fakeHash(`swap-${accountKey}-${Date.now()}`),
      sellUsd: request.amountUsd,
      buyDisplay: `~${received.toPrecision(3)} ${request.buySymbol.toUpperCase()}`,
    };
  }
}

function fakeAddress(seed: string): Hex {
  return `0x${createHash("sha256").update(seed).digest("hex").slice(0, 40)}` as Hex;
}

function fakeHash(seed: string): string {
  return `0x${createHash("sha256").update(seed).digest("hex")}`;
}
