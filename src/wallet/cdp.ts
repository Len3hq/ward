import { createHash } from "node:crypto";

import { CdpClient, parseUnits } from "@coinbase/cdp-sdk";
import { wrapFetchWithPayment } from "x402-fetch";

import type { CdpConfig } from "../config.ts";
import { installCdpProxy } from "../net.ts";
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

/**
 * Coinbase CDP wallet provider — the judged path.
 *
 * - Agent spender: one CDP Server Account (`ward-agent-spender`), shared.
 * - User wallet: a per-user CDP Smart Account (`cdpAccountName("user", …)`) owned by a
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

/** CDP account names: letters, digits and hyphens only, 2-36 characters. */
const CDP_NAME = /^[a-zA-Z0-9-]{2,36}$/;

/**
 * The CDP account name for one role of one account key.
 *
 * A CDP name may only contain letters, digits and hyphens and may be at most 36
 * characters, which a Ward principal violates twice over: `ward_<26-char ULID>`
 * carries an underscore, and `ward-owner-<key>` is 42 characters. Passing it
 * straight through is a 400 from `getOrCreateAccount`, which is what "connect my
 * wallet" was failing on.
 *
 * The smart-account ADDRESS is a function of this name, so what it returns for a
 * given key can never change — the same trap `ward.wallet.account_key` exists to
 * avoid. Hence the first branch: a legacy key (a bare Telegram id, which is what
 * the identity migration pinned) already produces a legal name, and must keep
 * producing exactly that one. Only keys that CDP would reject are rewritten, and
 * the ULID alone identifies the principal — the `ward_` prefix carries nothing.
 */
export function cdpAccountName(role: "owner" | "user", accountKey: string): string {
  const direct = `ward-${role}-${accountKey}`;
  if (CDP_NAME.test(direct)) return direct;

  const slug = accountKey.replace(/^ward_/, "").replace(/[^a-zA-Z0-9]/g, "");
  const short = `ward-${role[0]}-${slug}`;
  if (CDP_NAME.test(short)) return short;

  // Backstop for an account key that is neither shape: still deterministic.
  return `ward-${role[0]}-${createHash("sha256").update(accountKey).digest("hex").slice(0, 24)}`;
}

const TOKENS: Record<"base" | "base-sepolia", Record<string, Hex>> = {
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    CBETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  },
  "base-sepolia": {
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  },
};

export class CdpWalletProvider implements WalletProvider {
  readonly kind = "cdp" as const;
  #cdp: CdpClient;
  #network: "base" | "base-sepolia";
  /**
   * Gas sponsorship for the two smart-account user operations (grant / revoke).
   * Undefined → the smart account pays its own gas and must hold ETH. The
   * spender's own calls (`useSpendPermission`, `swap`, `transfer`) are plain
   * EOA transactions the SDK gives no paymaster option for, so the agent spender
   * always needs ETH regardless.
   */
  #paymasterUrl: string | undefined;

  constructor(config: CdpConfig, network: "base" | "base-sepolia") {
    installCdpProxy(); // route *.coinbase.com through CDP_PROXY_URL if set
    this.#cdp = new CdpClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      walletSecret: config.walletSecret,
    });
    this.#network = network;
    this.#paymasterUrl = config.paymasterUrl;
  }

  /** Spread into a user-operation call; empty when no paymaster is configured. */
  get #sponsor(): { paymasterUrl?: string } {
    return this.#paymasterUrl ? { paymasterUrl: this.#paymasterUrl } : {};
  }

  #token(symbol: string): Hex {
    const address = TOKENS[this.#network][symbol.toUpperCase()];
    if (!address) throw new Error(`unknown token ${symbol} on ${this.#network}`);
    return address;
  }

  network(): "base" | "base-sepolia" {
    return this.#network;
  }

  async #agentSpender() {
    return this.#cdp.evm.getOrCreateAccount({ name: AGENT_SPENDER_NAME });
  }

  async #userSmartAccount(accountKey: string) {
    const owner = await this.#cdp.evm.getOrCreateAccount({
      name: cdpAccountName("owner", accountKey),
    });
    return this.#cdp.evm.getOrCreateSmartAccount({
      name: cdpAccountName("user", accountKey),
      owner,
      enableSpendPermissions: true,
    });
  }

  async connect(accountKey: string): Promise<UserWallet> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    return { smartAccount: smart.address as Hex, agentSpender: spender.address as Hex };
  }

  async grantSpendPermission(
    accountKey: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
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
      ...this.#sponsor,
    });
    const grantedTx = await this.#settle(smart.address as Hex, op);
    const state = await this.readSpendPermission(accountKey);
    // `grantedTx` is spread over the live read, not just the fallback: the read
    // succeeds in the normal case and carries no tx of its own, so returning it
    // bare dropped the settlement hash and the chat lost its "tx 0x…" line —
    // exactly the link you need to confirm the grant landed.
    return state
      ? { ...state, grantedTx }
      : {
          status: "active",
          allowanceUsd,
          periodSeconds: Math.round(periodDays * 86_400),
          grantedTx,
        };
  }

  async readSpendPermission(accountKey: string): Promise<SpendPermissionState | null> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
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

  async revokeSpendPermission(accountKey: string): Promise<{ txHash: string }> {
    const smart = await this.#userSmartAccount(accountKey);
    const state = await this.readSpendPermission(accountKey);
    if (!state?.permissionHash) throw new Error("no active spend permission to revoke");
    const op = await this.#cdp.evm.revokeSpendPermission({
      address: smart.address as Hex,
      permissionHash: state.permissionHash as Hex,
      network: this.#network,
      ...this.#sponsor,
    });
    return { txHash: await this.#settle(smart.address as Hex, op) };
  }

  async usdcBalanceUsd(address: Hex): Promise<number> {
    const usdc = this.#token("USDC").toLowerCase();
    const { balances } = await this.#cdp.evm.listTokenBalances({ address, network: this.#network });
    const match = balances.find(
      (b) =>
        b.token.contractAddress.toLowerCase() === usdc || b.token.symbol?.toUpperCase() === "USDC",
    );
    return match ? Number(match.amount.amount) / 10 ** Number(match.amount.decimals) : 0;
  }

  /**
   * VERIFY LIVE. Pull `maxUsd` USDC from the user's smart account within the Spend
   * Permission, then pay the endpoint via `x402-fetch` (EIP-3009). The CDP account
   * is passed to `wrapFetchWithPayment` as the signer — confirm it satisfies the
   * x402 `Signer` shape, or wrap it with viem's `toAccount`.
   *
   * GET endpoints send no body; POST/PUT/PATCH endpoints send `request.body` as
   * `application/json` (the catalog's `body_template`, with `{subject}` filled).
   */
  async payX402(accountKey: string, request: X402Request): Promise<X402Result> {
    const spender = await this.#agentSpender();
    const permission = await this.#rawPermission(accountKey);
    if (permission) {
      await spender.useSpendPermission({
        spendPermission: permission,
        value: parseUnits(String(request.maxUsd), USDC_DECIMALS),
        network: this.#network,
      });
    }

    const maxValue = parseUnits(String(request.maxUsd), USDC_DECIMALS);
    const pay = wrapFetchWithPayment(
      fetch,
      spender as unknown as Parameters<typeof wrapFetchWithPayment>[1],
      maxValue,
    );

    const method = request.method.toUpperCase();
    const init: RequestInit = { method };
    if (request.body !== undefined && method !== "GET" && method !== "HEAD") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(request.body);
    }

    const response = await pay(request.url, init);
    if (!response.ok) throw new Error(`x402 endpoint returned ${response.status}`);

    const data: unknown = await response.json().catch(() => ({}));
    const paymentHeader = response.headers.get("x-payment-response") ?? "";
    const decoded = decodePayment(paymentHeader);
    return {
      data,
      txHash: decoded.txHash ?? "0x",
      amountUsd: decoded.amountUsd ?? request.expectedUsd,
    };
  }

  /**
   * VERIFY LIVE. Pull `amountUsd` USDC within the Spend Permission, then swap it on
   * Base via the CDP swap API. Testnet DEX liquidity is thin — the plan's fallback
   * is a WETH wrap/unwrap presented honestly as the swap primitive.
   */
  async swap(accountKey: string, request: SwapRequest): Promise<SwapResult> {
    const spender = await this.#agentSpender();
    const permission = await this.#rawPermission(accountKey);
    const fromAmount = parseUnits(String(request.amountUsd), USDC_DECIMALS);

    if (permission) {
      await spender.useSpendPermission({
        spendPermission: permission,
        value: fromAmount,
        network: this.#network,
      });
    }

    const result = await spender.swap({
      network: this.#network,
      fromToken: this.#token(request.sellSymbol),
      toToken: this.#token(request.buySymbol),
      fromAmount,
      slippageBps: 150,
    });

    const txHash =
      (result as { transactionHash?: string }).transactionHash ??
      (result as { userOpHash?: string }).userOpHash ??
      "0x";
    return {
      txHash,
      sellUsd: request.amountUsd,
      buyDisplay: `swapped into ${request.buySymbol.toUpperCase()}`,
    };
  }

  /**
   * VERIFY LIVE. Pull `amountUsd` USDC from the user's smart account into the agent
   * spender, within the Spend Permission — the same `useSpendPermission` primitive
   * `swap` and `payX402` use.
   *
   * ACP escrow is funded from the spender's own balance (the buyer address the CDP
   * adapter exposes), so without this pull an ACP job would spend Ward's float
   * while the ledger recorded it as the user's spend. A missing permission is a
   * hard error here, not the soft skip the near-atomic swap/x402 paths take.
   */
  async fundAgentFromUser(accountKey: string, amountUsd: number): Promise<{ pulledUsd: number }> {
    const spender = await this.#agentSpender();
    const permission = await this.#rawPermission(accountKey);
    if (!permission) {
      throw new Error(
        "no active Spend Permission — grant one before Ward can spend your USDC on an ACP job",
      );
    }
    await spender.useSpendPermission({
      spendPermission: permission,
      value: parseUnits(String(amountUsd), USDC_DECIMALS),
      network: this.#network,
    });
    return { pulledUsd: amountUsd };
  }

  /** VERIFY LIVE. Send USDC from the agent spender to any address. */
  async transferUsdcFromSpender(to: Hex, amountUsd: number): Promise<{ txHash: string }> {
    const spender = await this.#agentSpender();
    const result = await spender.transfer({
      to,
      amount: parseUnits(String(amountUsd), USDC_DECIMALS),
      token: "usdc",
      network: this.#network,
    });
    return { txHash: (result as { transactionHash?: string }).transactionHash ?? "0x" };
  }

  /** VERIFY LIVE. Send unspent USDC back from the agent spender to the user's smart account. */
  async refundUser(accountKey: string, amountUsd: number): Promise<{ txHash: string }> {
    const smart = await this.#userSmartAccount(accountKey);
    return this.transferUsdcFromSpender(smart.address as Hex, amountUsd);
  }

  /** The full on-chain SpendPermission struct, needed by `useSpendPermission`. */
  async #rawPermission(accountKey: string) {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    const { spendPermissions } = await this.#cdp.evm.listSpendPermissions({
      address: smart.address as Hex,
    });
    const match = spendPermissions
      .filter(
        (p) =>
          !p.revoked &&
          p.permission.spender.toLowerCase() === String(spender.address).toLowerCase(),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return match?.permission ?? null;
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

/** Settlement tx hash + settled amount from an x402 `X-Payment-Response` header (base64 JSON). */
function decodePayment(header: string): { txHash?: string; amountUsd?: number } {
  if (!header) return {};
  try {
    const d = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      transaction?: string;
      txHash?: string;
      amount?: string | number;
      value?: string | number;
    };
    const txHash = typeof d.transaction === "string" ? d.transaction : d.txHash;
    const raw = d.amount ?? d.value;
    const amountUsd = raw !== undefined ? Number(raw) / 10 ** USDC_DECIMALS : undefined;
    return {
      txHash: typeof txHash === "string" ? txHash : undefined,
      amountUsd: amountUsd !== undefined && Number.isFinite(amountUsd) ? amountUsd : undefined,
    };
  } catch {
    return {};
  }
}
