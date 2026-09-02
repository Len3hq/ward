import { CdpClient, parseUnits } from "@coinbase/cdp-sdk";

import type { CdpConfig } from "../config.ts";
import type { Hex, SpendPermissionState, UserWallet, WalletProvider } from "./provider.ts";

/**
 * Coinbase CDP wallet provider — the judged path.
 *
 * - Agent spender: one CDP Server Account (`ward-agent-spender`), shared.
 * - User wallet: a per-user CDP Smart Account (`ward-user-<tgId>`) owned by a
 *   per-user CDP Server Account. Hackathon-scoped managed-MPC custody — non-custodial
 *   in spirit (revocable Spend Permission), not an audited production custody stack.
 * - Spend Permission: `{ token: USDC, allowance, period: 1 day, spender }` granted
 *   from the user's smart account, revocable on-chain.
 *
 * Coinbase geoblocks some regions — `src/net.ts::installCdpProxy()` routes
 * `*.coinbase.com` through `CDP_PROXY_URL` for local dev.
 *
 * ── Verify live ───────────────────────────────────────────────────────────────
 * Field names below (`listSpendPermissions` → `.permission.spender` /
 * `.permission.allowance`, `waitForUserOperation` params, token-balance shape) are
 * taken from `@coinbase/cdp-sdk` 1.55 type declarations. Confirm against a live
 * CDP project once keys are available (see SIBYL-MEMORY.md's pattern; a
 * `wallet.cdp` opt-in test mirrors `memory.sibyl-mcp.test.ts`).
 */

const USDC_DECIMALS = 6;
const AGENT_SPENDER_NAME = "ward-agent-spender";

const USDC_ADDRESS: Record<string, Hex> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export class CdpWalletProvider implements WalletProvider {
  readonly kind = "cdp" as const;
  #cdp: CdpClient;
  #network: "base" | "base-sepolia";

  constructor(config: CdpConfig, network: "base" | "base-sepolia") {
    this.#cdp = new CdpClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      walletSecret: config.walletSecret,
    });
    this.#network = network;
  }

  network(): "base" | "base-sepolia" {
    return this.#network;
  }

  async #agentSpender() {
    return this.#cdp.evm.getOrCreateAccount({ name: AGENT_SPENDER_NAME });
  }

  async #userSmartAccount(tgId: string) {
    const owner = await this.#cdp.evm.getOrCreateAccount({ name: `ward-owner-${tgId}` });
    return this.#cdp.evm.getOrCreateSmartAccount({
      name: `ward-user-${tgId}`,
      owner,
      enableSpendPermissions: true,
    });
  }

  async connect(tgId: string): Promise<UserWallet> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(tgId),
      this.#agentSpender(),
    ]);
    return { smartAccount: smart.address as Hex, agentSpender: spender.address as Hex };
  }

  async grantSpendPermission(
    tgId: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(tgId),
      this.#agentSpender(),
    ]);
    const op = await this.#cdp.evm.createSpendPermission({
      spendPermission: {
        account: smart.address as Hex,
        spender: spender.address as Hex,
        token: "usdc",
        allowance: parseUnits(String(allowanceUsd), USDC_DECIMALS),
        periodInDays: periodDays,
      },
      network: this.#network,
    });
    const grantedTx = await this.#settle(smart.address as Hex, op);
    const state = await this.readSpendPermission(tgId);
    return (
      state ?? {
        status: "active",
        allowanceUsd,
        periodSeconds: Math.round(periodDays * 86_400),
        grantedTx,
      }
    );
  }

  async readSpendPermission(tgId: string): Promise<SpendPermissionState | null> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(tgId),
      this.#agentSpender(),
    ]);
    const { spendPermissions } = await this.#cdp.evm.listSpendPermissions({
      address: smart.address as Hex,
    });
    const mine = spendPermissions
      .filter((p) => p.permission.spender.toLowerCase() === String(spender.address).toLowerCase())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const latest = mine[0];
    if (!latest) return null;
    return {
      status: latest.revoked ? "revoked" : "active",
      allowanceUsd: Number(latest.permission.allowance) / 10 ** USDC_DECIMALS,
      periodSeconds: Number(latest.permission.period),
      permissionHash: latest.permissionHash,
    };
  }

  async revokeSpendPermission(tgId: string): Promise<{ txHash: string }> {
    const smart = await this.#userSmartAccount(tgId);
    const state = await this.readSpendPermission(tgId);
    if (!state?.permissionHash) throw new Error("no active spend permission to revoke");
    const op = await this.#cdp.evm.revokeSpendPermission({
      address: smart.address as Hex,
      permissionHash: state.permissionHash as Hex,
      network: this.#network,
    });
    return { txHash: await this.#settle(smart.address as Hex, op) };
  }

  async usdcBalanceUsd(address: Hex): Promise<number> {
    const usdc = USDC_ADDRESS[this.#network]?.toLowerCase();
    const { balances } = await this.#cdp.evm.listTokenBalances({ address, network: this.#network });
    const match = balances.find(
      (b) =>
        b.token.contractAddress.toLowerCase() === usdc || b.token.symbol?.toUpperCase() === "USDC",
    );
    return match ? Number(match.amount.amount) / 10 ** Number(match.amount.decimals) : 0;
  }

  async #settle(
    smartAccountAddress: Hex,
    op: { userOpHash: string; transactionHash?: string },
  ): Promise<string> {
    if (op.transactionHash) return op.transactionHash;
    try {
      const done = await this.#cdp.evm.waitForUserOperation({
        smartAccountAddress,
        userOpHash: op.userOpHash as Hex,
      });
      return (done as { transactionHash?: string }).transactionHash ?? op.userOpHash;
    } catch {
      return op.userOpHash;
    }
  }
}
