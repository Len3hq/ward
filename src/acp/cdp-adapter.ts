import type { AcpConfig } from "../config.ts";

/**
 * ── SUPERSEDED — nothing imports this. Safe to delete. ────────────────────────
 *
 * The plan was a CDP-backed `IEvmProviderAdapter` so ACP escrow would reuse the
 * agent spender instead of a Privy + Alchemy wallet. Registering the agent showed
 * why that doesn't work: the Virtuals console issues the agent its own wallet, and
 * the Signers panel authorizes keys *for that wallet* — the registered agent
 * wallet is the buyer, and an adapter can't substitute a different address for it.
 *
 * `acp/virtuals.ts` now uses the SDK's `PrivyAlchemyEvmProviderAdapter` (the only
 * working built-in — `ViemProviderAdapter` is an abstract scaffold whose every
 * method throws), and keeps ACP jobs on the user's money by moving the pulled
 * budget through that wallet: user → CDP spender → agent wallet → escrow, with the
 * remainder refunded back to the user.
 *
 * Kept only so the reasoning is on record; delete it whenever.
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
