import { encodeFunctionData, erc20Abi, parseUnits } from "viem";

import { loadConfig } from "../config.ts";
import type { Hex } from "../wallet/index.ts";
import { walletProvider } from "../wallet/index.ts";
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
 * when actually running the spike.
 *
 * ── Who pays ──────────────────────────────────────────────────────────────────
 * Escrow draws on the **registered ACP agent wallet**, not on Ward's CDP agent
 * spender — the Virtuals console issues that wallet and the signer key authorizes
 * signing for it. That wallet must therefore never be a Ward-funded float, or
 * every ACP job would be Ward paying while the ledger recorded a user spend. So
 * each job moves the user's own money through it and leaves it flat:
 *
 *   pull budget from ward-user-<tgId>   (their Spend Permission) → CDP spender
 *   forward CDP spender → buyerAddress  (skipped if they're the same address)
 *   session.fund()                      escrow draws on buyerAddress
 *   refund buyerAddress → user          whatever the job didn't consume
 *
 * `buyerAddress` is whatever `agent.getAddress()` reports, so this is correct
 * regardless of which wallet backs the adapter.
 */

const OFFERING_KEYWORD = "token risk";
/** USDC on Base — the escrow asset. */
const USDC_BASE: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const CHAIN_ID = 8453; // Base
/** Base gas is sub-cent; a refund shortfall above this is worth reporting. */
const DUST_USD = 0.01;

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

  async hire(tgId: string, job: AcpJobRequest): Promise<AcpJobResult> {
    const wallet = walletProvider();
    const { agent, adapter, stop } = await this.#agent();
    /** What we pulled from *this user's* smart account to fund escrow. */
    let pulledUsd = 0;
    try {
      const buyerAddress = (await agent.getAddress()) as Hex;
      const found: Array<{ walletAddress: string; offerings: Array<{ name: string }> }> =
        await agent.browseAgents(OFFERING_KEYWORD, { topK: 1 });
      const provider = found[0];
      if (!provider) {
        return notSettled(job, "no counterparty offering token-risk assessment");
      }

      const chainId = CHAIN_ID;
      const budget = job.maxUsd;

      /** The counterparty's raw output, captured off `job.submitted`. */
      let deliverable: string | null = null;

      const settled = await new Promise<AcpJobResult>((resolve) => {
        let done = false;
        const finish = (result: AcpJobResult) => {
          if (done) return;
          done = true;
          resolve(result);
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent.on("entry", async (session: any, entry: any) => {
          if (entry.kind !== "system") return;
          try {
            if (entry.event.type === "budget.set") {
              // The user's money, not Ward's: pull the budget through *this user's*
              // Spend Permission, then forward it to the address escrow will draw
              // on. Throws if they have no active permission — the job never funds.
              ({ pulledUsd } = await wallet.fundAgentFromUser(tgId, budget));
              const spender = (await wallet.connect(tgId)).agentSpender;
              if (spender.toLowerCase() !== buyerAddress.toLowerCase()) {
                await wallet.transferUsdcFromSpender(buyerAddress, pulledUsd);
              }
              await session.fund(); // AssetToken.usdc(budget, chainId) — cap enforced by our gate
            } else if (entry.event.type === "job.submitted") {
              // `JobSubmittedEvent.deliverable` is the counterparty's output, carried
              // on the event itself — NOT a `contentType: "deliverable"` message. An
              // entry scan finds nothing here, and a null result scores as a thin
              // deliverable (-0.1 trust) on a job that actually succeeded.
              deliverable = entry.event.deliverable ?? null;
              // Ward is its own evaluator (`evaluatorAddress: buyerAddress`), so the
              // funds stay escrowed until we call this.
              await session.complete("delivered");
            } else if (entry.event.type === "job.completed") {
              finish({
                counterpartyId: `agent://${provider.walletAddress}`,
                jobType: job.jobType,
                outcomeSummary: "job completed",
                rawResult: parseDeliverable(deliverable),
                settled: true,
                amountUsd: budget,
              });
              await agent.stop();
            } else if (entry.event.type === "job.rejected" || entry.event.type === "job.expired") {
              finish(notSettled(job, `job ${entry.event.type}`));
              await agent.stop();
            }
          } catch (err) {
            // A throw in here (no Spend Permission, a failed fund) would otherwise
            // hang the job until the timeout with the user's money already pulled.
            finish(notSettled(job, err instanceof Error ? err.message : "job handler failed"));
            await agent.stop().catch(() => undefined);
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

      // Escrow releases to the buyer, so whatever the job didn't consume is the
      // user's money sitting in Ward's ACP wallet. Send it back from there — the
      // CDP provider can't sign for that wallet, only the ACP adapter can.
      const unspent = round6(pulledUsd - (settled.settled ? settled.amountUsd : 0));
      if (unspent > 0) {
        try {
          const { smartAccount } = await wallet.connect(tgId);
          const sent = await refundFromBuyer(adapter, chainId, buyerAddress, smartAccount, unspent);
          const short = round6(unspent - sent);
          if (short > DUST_USD) {
            // Base gas is sub-cent, so a gap this size is a real discrepancy, not
            // the paymaster — surface it instead of quietly keeping the money.
            console.error(`ACP refund to ${tgId} short by $${short}`);
            settled.outcomeSummary += ` [refunded $${sent.toFixed(2)} of $${unspent.toFixed(2)} — $${short.toFixed(2)} owed to user]`;
          }
        } catch (err) {
          // The user is owed money — say so loudly and persist it in the job history
          // rather than let a silent catch bury it.
          const why = err instanceof Error ? err.message : String(err);
          console.error(`ACP refund of $${unspent} to ${tgId} FAILED: ${why}`);
          settled.outcomeSummary += ` [refund of $${unspent.toFixed(2)} failed — owed to user]`;
        }
      }

      return settled;
    } finally {
      await stop().catch(() => undefined);
    }
  }

  async #agent(): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter: any;
    stop: () => Promise<void>;
  }> {
    const config = loadConfig();
    if (!config.acp) {
      throw new Error(
        "ACP_MODE=virtuals but ACP credentials are missing (need ACP_WALLET_ADDRESS, " +
          "ACP_WALLET_ID, ACP_SIGNER_KEY). See ACP.md — run the spike or set ACP_MODE=stub.",
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chains: any;
    try {
      chains = await import("@account-kit/infra" as string);
    } catch {
      throw new Error("ACP_MODE=virtuals needs `@account-kit/infra` (an SDK dep). See ACP.md.");
    }

    const { AcpAgent, PrivyAlchemyEvmProviderAdapter } = mod;
    // `PrivyAlchemyEvmProviderAdapter` is the only working built-in EVM adapter —
    // `ViemProviderAdapter` is an abstract scaffold whose every method throws.
    const adapter = await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: config.acp.walletAddress,
      walletId: config.acp.walletId,
      signerPrivateKey: config.acp.signerKey,
      chains: [chains.base],
      ...(config.acp.builderCode ? { builderCode: config.acp.builderCode } : {}),
    });
    // `evmProvider`, NOT `provider` — the SDK README says `provider`, but
    // `clientFactory.js` destructures `{ evmProvider, solanaProvider }` and throws
    // "At least one provider must be provided" otherwise. Confirmed against 0.1.12.
    const agent = await AcpAgent.create({ evmProvider: adapter });
    return { agent, adapter, stop: () => agent.stop() };
  }
}

/**
 * Send USDC out of the ACP agent wallet, via the adapter that holds its signer.
 * `IEvmProviderAdapter.sendTransaction` takes a viem `Call`, so this is a plain
 * ERC-20 transfer — there is no wallet-provider path to this address.
 *
 * Capped at the wallet's real balance. Base is in the SDK's
 * `ERC20_SPONSORED_CHAINS` and the adapter routes through an `alchemy-rpc-erc20`
 * endpoint, so gas is paid in USDC out of this wallet — leaving it holding
 * slightly less than `pulled − settled`. Refunding the arithmetic remainder would
 * revert and report a false "owed to user".
 *
 * Returns what was actually sent, in USD.
 */
async function refundFromBuyer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adapter: any,
  chainId: number,
  from: Hex,
  to: Hex,
  amountUsd: number,
): Promise<number> {
  const wanted = parseUnits(String(amountUsd), USDC_DECIMALS);
  const balance = (await adapter.readContract(chainId, {
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [from],
  })) as bigint;

  const value = wanted < balance ? wanted : balance;
  if (value <= 0n) return 0;

  await adapter.sendTransaction(chainId, {
    to: USDC_BASE,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, value],
    }),
  });
  return Number(value) / 10 ** USDC_DECIMALS;
}

/**
 * The deliverable is a string on the wire. Prefer the parsed object (the report
 * `counterparty/score.ts` produces), but keep the raw string rather than dropping
 * a non-JSON deliverable — it still goes through `validateExternalData`, and a
 * dropped result would misread as a counterparty that delivered nothing.
 */
function parseDeliverable(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** USDC has 6 decimals — keep float subtraction from inventing a dust refund. */
function round6(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
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
