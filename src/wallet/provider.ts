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
  connect(tgId: string): Promise<UserWallet>;
  /** Grant a USDC Spend Permission from the user's smart account to the agent spender. */
  grantSpendPermission(
    tgId: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState>;
  /** Current permission for this user (from chain), or `null` if none was ever granted. */
  readSpendPermission(tgId: string): Promise<SpendPermissionState | null>;
  /** Submit the on-chain revocation. */
  revokeSpendPermission(tgId: string): Promise<{ txHash: string }>;
  /** USDC balance of an address, in whole USD. */
  usdcBalanceUsd(address: Hex): Promise<number>;
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
