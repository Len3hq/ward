import { loadConfig } from "../config.ts";
import type { AcpJobRequest, AcpJobResult, AcpProvider } from "./provider.ts";

/**
 * Real Virtuals ACP path — `@virtuals-protocol/acp-node-v2`.
 *
 * ── GO / NO-GO (see ACP.md) ───────────────────────────────────────────────────
 * This is a SPIKE. Before it counts:
 *   1. `npm i @virtuals-protocol/acp-node-v2`
 *   2. Register the agent at https://app.virtuals.io/acp/new, add a signer,
 *      copy the wallet id + signer key + builder code.
 *   3. Set ACP_MODE=virtuals + ACP_WALLET_ID / ACP_SIGNER_KEY / ACP_BUILDER_CODE.
 *   4. Run one job end-to-end: created → escrowed → fulfilled → paid.
 * If it does not settle, cut it — set ACP_MODE=stub, delete the acp_job intent
 * from the demo, keep the pre-seeded trust history for the memory story. **Never
 * fake a settlement.**
 *
 * The SDK is loaded dynamically so the (heavy, beta) dependency is only needed
 * when actually running the spike. The event flow below is from the v2 README;
 * confirm every call against a live run.
 */

const OFFERING_KEYWORD = "token risk";

export class VirtualsAcpProvider implements AcpProvider {
  readonly kind = "virtuals" as const;

  async preferredCounterparty(): Promise<string> {
    const { agent, stop } = await this.#agent();
    try {
      const results: Array<{ walletAddress: string; name?: string }> = await agent.browseAgents(
        OFFERING_KEYWORD,
        { topK: 1 },
      );
      const top = results[0];
      if (!top) throw new Error("no ACP agent offers token-risk assessment");
      return `agent://${top.walletAddress}`;
    } finally {
      await stop();
    }
  }

  async hire(_tgId: string, job: AcpJobRequest): Promise<AcpJobResult> {
    const { agent, stop } = await this.#agent();
    try {
      const buyerAddress: string = await agent.getAddress();
      const found: Array<{ walletAddress: string; offerings: Array<{ name: string }> }> =
        await agent.browseAgents(OFFERING_KEYWORD, { topK: 1 });
      const provider = found[0];
      if (!provider) {
        return notSettled(job, "no counterparty offering token-risk assessment");
      }

      const chainId = 8453; // Base
      const budget = job.maxUsd;

      const settled = await new Promise<AcpJobResult>((resolve) => {
        let done = false;
        const finish = (result: AcpJobResult) => {
          if (done) return;
          done = true;
          resolve(result);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent.on("entry", async (session: any, entry: any) => {
          if (entry.kind === "system") {
            if (entry.event.type === "budget.set") {
              await session.fund(); // AssetToken.usdc(budget, chainId) — cap enforced by our gate
            } else if (entry.event.type === "job.submitted") {
              await session.complete("delivered");
            } else if (entry.event.type === "job.completed") {
              const deliverable = session.entries.findLast?.(
                (e: { kind: string; contentType?: string; content?: unknown }) =>
                  e.kind === "message" && e.contentType === "deliverable",
              );
              finish({
                counterpartyId: `agent://${provider.walletAddress}`,
                jobType: job.jobType,
                outcomeSummary: "job completed",
                rawResult: deliverable?.content ?? null,
                settled: true,
                amountUsd: budget,
              });
              await agent.stop();
            } else if (entry.event.type === "job.rejected" || entry.event.type === "job.expired") {
              finish(notSettled(job, `job ${entry.event.type}`));
              await agent.stop();
            }
          }
        });

        agent.start().then(async () => {
          await agent.createJobByOfferingName(
            chainId,
            provider.offerings[0]!.name,
            provider.walletAddress,
            { ticker: job.subject },
            { evaluatorAddress: buyerAddress },
          );
        });

        setTimeout(() => finish(notSettled(job, "timed out")), 180_000);
      });

      return settled;
    } finally {
      await stop().catch(() => undefined);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async #agent(): Promise<{ agent: any; stop: () => Promise<void> }> {
    const config = loadConfig();
    if (!config.acp) {
      throw new Error(
        "ACP_MODE=virtuals but ACP credentials are missing. See ACP.md — run the spike or set ACP_MODE=stub.",
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mod: any;
    try {
      mod = await import("@virtuals-protocol/acp-node-v2" as string);
    } catch {
      throw new Error(
        "ACP_MODE=virtuals but `@virtuals-protocol/acp-node-v2` is not installed. See ACP.md.",
      );
    }
    const { AcpAgent } = mod;
    // The v2 SDK ships a Privy+Alchemy adapter; a CDP-backed IEvmProviderAdapter
    // (reusing the agent spender) is the intended integration — see acp/cdp-adapter.ts.
    const { CdpEvmProviderAdapter } =
      (await import("./cdp-adapter.ts")) as typeof import("./cdp-adapter.ts");
    const agent = await AcpAgent.create({
      provider: await CdpEvmProviderAdapter.create(config.acp),
    });
    return { agent, stop: () => agent.stop() };
  }
}

function notSettled(job: AcpJobRequest, why: string): AcpJobResult {
  return {
    counterpartyId: "agent://unknown",
    jobType: job.jobType,
    outcomeSummary: `did not settle: ${why}`,
    rawResult: null,
    settled: false,
    amountUsd: 0,
  };
}
