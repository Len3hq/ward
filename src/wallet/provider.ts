import { loadConfig } from "../config.ts";
import { CdpWalletProvider } from "./cdp.ts";
import { StubWalletProvider } from "./stub.ts";

/**
 * Wallet & spend-permission provider. Adapted from Len3's `services/privy/*` — a
 * provider-managed MPC wallet the agent controls, plus a relayed-payment flow —
 * moved to Coinbase CDP. Two implementations behind one interface:
 *
 * - `cdp` (`wallet/cdp.ts`) — the real path: CDP Server Account (agent spender),
 *   CDP Smart Account (user), on-chain Spend Permission on Base. Selected when
 *   `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` are all set.
 * - `stub` (`wallet/stub.ts`) — deterministic fake addresses + in-memory
 *   permission state for tests and no-key dev. **Not the judged path.**
 *
 * The provider is pure infra: it never touches Sibyl Memory. The `wallet` node
 * calls it, then persists the result via `writeWallet`.
 */

export type Hex = `0x${string}`;
export type SpendPermissionStatus = "active" | "revoked" | "none";

export interface UserWallet {
  smartAccount: Hex;
  agentSpender: Hex;
}

export interface SpendPermissionState {
  status: SpendPermissionStatus;
  allowanceUsd: number;
  periodSeconds: number;
  permissionHash?: string;
  grantedTx?: string;
}

export interface WalletProvider {
  readonly kind: "cdp" | "stub";
  network(): "base" | "base-sepolia";
  /** Create/fetch the user's smart account and the shared agent spender. Idempotent. */
  connect(accountKey: string): Promise<UserWallet>;
  /** Grant a USDC Spend Permission from the user's smart account to the agent spender. */
  grantSpendPermission(
    accountKey: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState>;
  /** Current permission for this user (from chain), or `null` if none was ever granted. */
  readSpendPermission(accountKey: string): Promise<SpendPermissionState | null>;
  /** Submit the on-chain revocation. */
  revokeSpendPermission(accountKey: string): Promise<{ txHash: string }>;
  /** USDC balance of an address, in whole USD. */
  usdcBalanceUsd(address: Hex): Promise<number>;

  /** Pay an x402 endpoint from the agent spender (pulls within the Spend Permission). */
  payX402(accountKey: string, request: X402Request): Promise<X402Result>;
  /** Capped swap on Base, funded from the agent spender. */
  swap(accountKey: string, request: SwapRequest): Promise<SwapResult>;

  /**
   * Pull `amountUsd` USDC from the user's smart account into the agent spender,
   * within their Spend Permission. ACP escrow is funded from the spender's own
   * balance, so this pull is what makes a job **the user's** spend rather than
   * Ward's float. No active permission → throw; never silently fall back.
   */
  fundAgentFromUser(accountKey: string, amountUsd: number): Promise<{ pulledUsd: number }>;
  /**
   * Send USDC from the agent spender to any address. Used to forward a user's
   * pulled budget on to whatever address the ACP escrow actually draws on, which
   * is the registered agent wallet rather than the spender.
   */
  transferUsdcFromSpender(to: Hex, amountUsd: number): Promise<{ txHash: string }>;
  /**
   * Return unspent USDC to the user's smart account — a job that doesn't settle,
   * or settles under budget, must not leave the user's money in a Ward wallet.
   */
  refundUser(accountKey: string, amountUsd: number): Promise<{ txHash: string }>;
}

export interface X402Request {
  url: string;
  method: string;
  /** JSON body for POST/PUT/PATCH endpoints; `undefined` for GET. */
  body?: unknown;
  /** Catalog price — what the stub charges; the real price comes from the 402 response. */
  expectedUsd: number;
  /** Hard cap on what the endpoint may charge, in USD. */
  maxUsd: number;
}
export interface X402Result {
  data: unknown;
  txHash: string;
  amountUsd: number;
}

export interface SwapRequest {
  sellSymbol: string;
  buySymbol: string;
  amountUsd: number;
}
export interface SwapResult {
  txHash: string;
  sellUsd: number;
  /** Human-readable received amount, e.g. "~0.0121 ETH". */
  buyDisplay: string;
}

let cached: WalletProvider | null = null;

export function walletProvider(): WalletProvider {
  if (cached) return cached;
  const config = loadConfig();
  cached = config.cdp
    ? new CdpWalletProvider(config.cdp, config.baseNetwork)
    : new StubWalletProvider(config.baseNetwork);
  return cached;
}

/** Test hook. */
export function resetWalletProvider(): void {
  cached = null;
}
