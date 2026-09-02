import type { AcpConfig } from "../config.ts";

/**
 * A CDP-backed `IEvmProviderAdapter` for `@virtuals-protocol/acp-node-v2`, so ACP
 * escrow reuses the agent spender instead of standing up a Privy + Alchemy wallet.
 *
 * ── SPIKE SKELETON ────────────────────────────────────────────────────────────
 * The v2 SDK's `IEvmProviderAdapter` needs: `sendCalls(chainId, calls)`,
 * `signMessage`, `signTypedData`, `getTransactionReceipt`, `readContract`,
 * `getLogs`. Back each with the CDP agent spender (`cdp.evm` + a viem public
 * client on `BASE_RPC_URL`). Fill this in during the go/no-go spike (`ACP.md`);
 * until then `ACP_MODE=virtuals` throws a clear error via `create()`.
 */
export class CdpEvmProviderAdapter {
  private constructor() {
    // placeholder
  }

  static async create(config: AcpConfig): Promise<CdpEvmProviderAdapter> {
    void config;
    throw new Error(
      "CdpEvmProviderAdapter is a spike skeleton — implement IEvmProviderAdapter over the CDP " +
        "agent spender before running ACP_MODE=virtuals. See ACP.md and acp/cdp-adapter.ts.",
    );
  }
}
