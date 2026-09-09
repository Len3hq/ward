import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";

import { loadConfig } from "../config.ts";
import type { Hex } from "../wallet/index.ts";
import { walletProvider } from "../wallet/index.ts";
import { withDeadline } from "../wallet/cdp.ts";
import type { AcpCandidate, AcpJobRequest, AcpJobResult, AcpProvider } from "./provider.ts";

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
 *   pull the SELLER'S PRICE from ward-user-<accountKey>  (Spend Permission) → spender
 *   forward CDP spender → buyerAddress  (skipped if they're the same address)
 *   session.fund()                      escrow draws exactly that, on buyerAddress
 *
 * There is deliberately no refund step. Moving `job.maxUsd` and returning the change
 * cannot work: Virtuals policy-gates transfers out of the ACP wallet, denying them
 * with "RPC request denied due to policy violation" and asking a human to approve
 * each one. So every job — successful ones included — stranded its change in a
 * wallet nothing could empty. Funding the price the seller named leaves no change.
 *
 * `buyerAddress` is whatever `agent.getAddress()` reports, so this is correct
 * regardless of which wallet backs the adapter.
 */

/**
 * How long the buyer-side refund may take before Ward stops waiting on it.
 *
 * Privy's approval window is 300s, and it spends all of it: two production turns
 * were parked 339s and 325s, almost entirely here, waiting on a human to click
 * approve in the Virtuals console for a transfer its policy had already denied.
 * Nobody was going to click it. The refund still gets its attempt — this only stops
 * a hold that will not be granted from holding the user's turn hostage while the
 * fallback that CAN sign waits behind it.
 */
const BUYER_REFUND_TIMEOUT_MS = 30_000;

const OFFERING_KEYWORD = "token risk";
/**
 * Pin the counterparty to one wallet, when set (`ACP_COUNTERPARTY_WALLET`).
 *
 * Without it, selection is `browseAgents(keyword, { topK: 1 })` — whichever agent
 * Virtuals happens to rank first for "token risk". That is the right default:
 * `ACP.md` prefers hiring a genuinely independent agent over Ward's own seller. But
 * it also means the counterparty can change between runs without anything in Ward
 * changing, which makes a demo unreproducible and makes "who did we hire, and do we
 * trust them?" a question about a stranger.
 *
 * Setting this pins the hire to a known address — used to reach Ward's own
 * `counterparty/` seller, which `ACP.md` requires be disclosed as same-team rather
 * than passed off as a third party.
 */
function pinnedCounterparty(): string | null {
  const pinned = process.env.ACP_COUNTERPARTY_WALLET?.trim().toLowerCase();
  return pinned && /^0x[a-f0-9]{40}$/.test(pinned) ? pinned : null;
}

/**
 * The agent to hire: the pinned wallet, looked up directly, else the top search match.
 *
 * A pin resolves through `getAgentByWalletAddress` rather than `browseAgents`,
 * deliberately. Virtuals' marketplace search is a separate index that an agent can be
 * absent from for a long time after its offering exists — measured on Ward's own
 * seller, which `getAgentByWalletAddress` returned complete with its offering while
 * `browseAgents` could not find it under any keyword, including the agent's own name,
 * at topK 50. Search is the right tool for "find me someone"; it is the wrong tool
 * for "fetch the agent I already named".
 *
 * A pin that resolves to nothing, or to an agent with no offering, is a hard error.
 * Quietly hiring a stranger because your own agent is not indexed yet is exactly the
 * failure that should be loud.
 */
async function selectCounterparty<
  T extends { walletAddress: string; offerings?: unknown[] },
>(lookup: {
  byWallet: (wallet: string) => Promise<T | null>;
  browse: (keyword: string, opts: { topK: number }) => Promise<T[]>;
}): Promise<T> {
  const pinned = pinnedCounterparty();
  if (pinned === null) {
    const [top] = await lookup.browse(OFFERING_KEYWORD, { topK: 1 });
    if (!top) throw new Error("no ACP agent offers token-risk assessment");
    return top;
  }

  const match = await lookup.byWallet(pinned);
  if (!match) {
    throw new Error(
      `ACP_COUNTERPARTY_WALLET ${pinned} is not a registered ACP agent. ` +
        `Refusing to hire someone else instead.`,
    );
  }
  if (!match.offerings?.length) {
    throw new Error(
      `ACP_COUNTERPARTY_WALLET ${pinned} has no offerings, so there is nothing to buy ` +
        `and no price for escrow to fund. Add one on app.virtuals.io.`,
    );
  }
  return match;
}
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
      const chosen = await selectCounterparty<{
        walletAddress: string;
        name?: string;
        offerings?: unknown[];
      }>({
        byWallet: (wallet) => agent.getAgentByWalletAddress(wallet),
        browse: (keyword, opts) => agent.browseAgents(keyword, opts),
      });
      return `agent://${chosen.walletAddress}`;
    } finally {
      await stop();
    }
  }

  /**
   * Everyone on Virtuals selling token-risk assessment, marketplace order.
   *
   * This is what opens Ward up beyond its own seller: `browseAgents` is the real
   * directory, so a hire can reach any registered agent that offers the work. Agents
   * with no offering are dropped — there is nothing to buy from them and no price
   * for escrow to fund, so listing them would only produce a hire that fails.
   *
   * A pin (`ACP_COUNTERPARTY_WALLET`) short-circuits this to one agent, which is
   * what a reproducible demo needs; unset it and Ward shops the whole directory.
   */
  async candidates(_jobType: string, limit: number): Promise<AcpCandidate[]> {
    const { agent, stop } = await this.#agent();
    try {
      const pinned = pinnedCounterparty();
      if (pinned !== null) {
        const match = (await agent.getAgentByWalletAddress(pinned)) as {
          walletAddress?: string;
          name?: string;
          offerings?: unknown[];
        } | null;
        if (!match?.offerings?.length) return [];
        return [{ id: `agent://${match.walletAddress}`, name: match.name }];
      }

      const found = (await agent.browseAgents(OFFERING_KEYWORD, { topK: limit })) as Array<{
        walletAddress?: string;
        name?: string;
        offerings?: unknown[];
      }>;
      return found
        .filter((a) => typeof a.walletAddress === "string" && !!a.offerings?.length)
        .map((a) => ({ id: `agent://${a.walletAddress}`, name: a.name }));
    } finally {
      await stop().catch(() => undefined);
    }
  }

  /**
   * Return whatever is stranded in Ward's ACP wallet to the user's smart account.
   *
   * Escrow draws on that wallet, so a job that dies between the forward and
   * settlement leaves the user's money there — one hop past the CDP spender, where
   * `scripts/sweep-spender.ts` cannot reach it and only this adapter can sign. It
   * happened: $0.50, after `session.fund()` reverted.
   *
   * The wallet is meant to rest at zero (see the note at the top of this file), so
   * anything sitting in it belongs to whoever last had a job fail there — hence the
   * caller names the user rather than this guessing.
   */
  async recoverStranded(accountKey: string): Promise<{ movedUsd: number; from: Hex; to: Hex }> {
    const wallet = walletProvider();
    const { agent, adapter, stop } = await this.#agent();
    try {
      const from = (await agent.getAddress()) as Hex;
      const { smartAccount } = await wallet.connect(accountKey);
      const to = smartAccount as Hex;
      const raw = (await adapter.readContract(CHAIN_ID, {
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [from],
      })) as bigint;
      const heldUsd = Number(formatUnits(raw, USDC_DECIMALS));
      if (heldUsd <= 0) return { movedUsd: 0, from, to };
      return { movedUsd: await refundFromBuyer(adapter, CHAIN_ID, from, to, heldUsd), from, to };
    } finally {
      await stop().catch(() => undefined);
    }
  }

  async hire(accountKey: string | null, job: AcpJobRequest): Promise<AcpJobResult> {
    if (accountKey === null) {
      throw new Error(
        "cannot hire on ACP without a connected wallet — escrow must be funded from " +
          "the user's own Spend Permission, not Ward's float",
      );
    }
    const wallet = walletProvider();
    const { agent, adapter, stop } = await this.#agent();
    /** What we pulled from *this user's* smart account to fund escrow. */
    let pulledUsd = 0;
    try {
      const buyerAddress = (await agent.getAddress()) as Hex;
      let provider: { walletAddress: string; offerings: Array<{ name: string }> };
      try {
        // Hire the agent the CALLER chose, when it chose one. Re-selecting here
        // meant the confirmation and the hire were two independent lookups, so a
        // directory that reordered in between could hire someone the user never
        // approved — and the trust score they were shown belonged to a different
        // agent. Fall back to selection only when nobody named one.
        const named = job.counterpartyId?.replace(/^agent:\/\//, "").toLowerCase();
        if (named && /^0x[a-f0-9]{40}$/.test(named)) {
          const match = (await agent.getAgentByWalletAddress(named)) as {
            walletAddress: string;
            offerings?: Array<{ name: string }>;
          } | null;
          if (!match?.offerings?.length) {
            return notSettled(
              job,
              `${named} is not a registered ACP agent with an offering`,
              named,
            );
          }
          provider = { walletAddress: match.walletAddress, offerings: match.offerings };
        } else {
          provider = await selectCounterparty<{
            walletAddress: string;
            offerings: Array<{ name: string }>;
          }>({
            byWallet: (wallet) => agent.getAgentByWalletAddress(wallet),
            browse: (keyword, opts) => agent.browseAgents(keyword, opts),
          });
        }
      } catch (error) {
        return notSettled(job, error instanceof Error ? error.message : String(error));
      }

      const chainId = CHAIN_ID;
      /** The ceiling the user approved. Nothing above this is paid. */
      const budget = job.maxUsd;
      /** What the seller actually asked for, once they name it. */
      let funded = 0;

      /** The counterparty's raw output, captured off `job.submitted`. */
      let deliverable: string | null = null;

      /**
       * The on-chain transfer that funded this job's escrow, when there was one.
       *
       * The receipt used to end at "job completed" with no way to check it, because
       * the SDK settles escrow internally and hands back no hash. This is the hash
       * Ward does hold: its own USDC transfer to the address escrow draws on, same
       * chain and same money, which is what makes the spend verifiable at all.
       */
      let fundingTx: string | null = null;

      const settled = await new Promise<AcpJobResult>((resolve) => {
        let done = false;
        const finish = (result: AcpJobResult) => {
          if (done) return;
          done = true;
          resolve(result);
        };

        /**
         * The job THIS hire created. Every event is filtered against it.
         *
         * The agent emits entries for every session it holds open, and the handler
         * used to act on any of them: a stale job completing resolved whichever hire
         * happened to be waiting, with that job's deliverable. Measured — a hire for
         * AERO was resolved by an older VVV job finishing, and the user was charged
         * for AERO, shown VVV's report, and the counterparty credited +0.07 trust for
         * work on a different job. Only `resolved_by` in the deliverable made it
         * visible at all.
         */
        let ourJobId: string | null = null;
        /** Entries seen before the id is known — the job exists on chain before
         * `createJobByOfferingName` resolves locally, so the seller can price it in
         * that window. Dropping those would deadlock the very race this guards. */
        const early: Array<[unknown, unknown]> = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleEntry = async (session: any, entry: any) => {
          if (entry.kind !== "system") return;
          try {
            if (entry.event.type === "budget.set") {
              // Move what the seller ASKED for, not Ward's ceiling.
              //
              // This used to pull `job.maxUsd` — $0.50 — for a job priced at $0.01,
              // then try to refund the ~$0.49 difference out of the ACP wallet. That
              // refund cannot work: Virtuals policy-gates transfers out of that
              // wallet ("RPC request denied due to policy violation") and asks a
              // human to approve each one. So every job, including a successful one,
              // stranded the change. Funding the actual price leaves nothing to
              // refund and nothing to strand.
              //
              // `maxUsd` goes back to being what it should always have been: a cap to
              // refuse against, not the amount to move. It also stops a $0.01 purchase
              // reserving $0.50 of the user's daily allowance.
              const asked = Number(entry.event.amount);
              if (!Number.isFinite(asked) || asked <= 0) {
                throw new Error(
                  `the seller set an unusable budget (${String(entry.event.amount)})`,
                );
              }
              if (asked > budget) {
                throw new Error(
                  `the seller asks $${asked}, over the $${budget} you approved — nothing was paid`,
                );
              }
              funded = asked;
              ({ pulledUsd } = await wallet.fundAgentFromUser(accountKey, asked));
              const spender = (await wallet.connect(accountKey)).agentSpender;
              if (spender.toLowerCase() !== buyerAddress.toLowerCase()) {
                ({ txHash: fundingTx } = await wallet.transferUsdcFromSpender(
                  buyerAddress,
                  pulledUsd,
                ));
              }
              await session.fund(); // draws `funded`, which the gate already capped at `budget`
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
                // What the job actually cost, not the ceiling — this is the number
                // that reaches the spend ledger and the user's daily cap.
                amountUsd: funded || budget,
                // Both were already known here and both were dropped on the floor:
                // the ledger recorded `tx_hash: "0x"` for every hire, and the reply
                // named neither the job nor a transaction anyone could look up.
                ...(fundingTx === null ? {} : { txHash: fundingTx }),
                ...(ourJobId === null ? {} : { jobId: ourJobId }),
              });
              await agent.stop();
            } else if (entry.event.type === "job.rejected" || entry.event.type === "job.expired") {
              finish(notSettled(job, `job ${entry.event.type}`, provider.walletAddress));
              await agent.stop();
            }
          } catch (err) {
            // A throw in here (no Spend Permission, a failed fund) would otherwise
            // hang the job until the timeout with the user's money already pulled.
            finish(
              notSettled(
                job,
                err instanceof Error ? err.message : "job handler failed",
                provider.walletAddress,
              ),
            );
            await agent.stop().catch(() => undefined);
          }
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent.on("entry", (session: any, entry: any) => {
          if (ourJobId === null) {
            early.push([session, entry]);
            return;
          }
          if (String(session.jobId) !== ourJobId) return;
          void handleEntry(session, entry);
        });

        agent.start().then(async () => {
          const created = await agent.createJobByOfferingName(
            chainId,
            provider.offerings[0]!.name,
            provider.walletAddress,
            { ticker: job.subject },
            { evaluatorAddress: buyerAddress },
          );
          ourJobId = String(created);
          // Replay anything that arrived while the id was unknown, ours only.
          for (const [session, entry] of early.splice(0)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (String((session as any).jobId) === ourJobId) void handleEntry(session, entry);
          }
        });

        setTimeout(() => finish(notSettled(job, "timed out", provider.walletAddress)), 180_000);
      });

      // Escrow releases to the buyer, so whatever the job didn't consume is the
      // user's money sitting in Ward's ACP wallet. Send it back from there — the
      // CDP provider can't sign for that wallet, only the ACP adapter can.
      const unspent = round6(pulledUsd - (settled.settled ? settled.amountUsd : 0));
      if (unspent > 0) {
        try {
          const { smartAccount } = await wallet.connect(accountKey);
          // A THROW here must not skip the spender fallback below.
          //
          // Production, 2026-09-09: a $0.01 hire failed at the funding wait, and the
          // refund never happened — "[refund of $0.01 failed — owed to user]" — even
          // though the money was reachable. `refundFromBuyer` moves USDC out of the
          // Virtuals ACP wallet, which Privy policy-gates: it printed "Manual approval
          // required … Reason: RPC request denied due to policy violation", blocked the
          // user's turn for the full 300s approval window, then threw. That throw went
          // straight past the `short > DUST_USD` fallback — the one route that CAN
          // sign, the CDP spender — and into the outer catch. Two users, same turn.
          //
          // Treat a failed buyer-side refund as "moved nothing" rather than as the end
          // of the attempt, and let the fallback run. The user's money is the point.
          let sent = 0;
          try {
            sent = await withDeadline("ACP wallet refund", BUYER_REFUND_TIMEOUT_MS, () =>
              refundFromBuyer(adapter, chainId, buyerAddress, smartAccount, unspent),
            );
          } catch (buyerErr) {
            console.error(
              `ACP refund from the ACP wallet failed, trying the spender: ` +
                `${buyerErr instanceof Error ? buyerErr.message : String(buyerErr)}`,
            );
          }
          let short = round6(unspent - sent);

          // The money is only at `buyerAddress` if escrow ever released it. When the
          // job fails BEFORE funding — the forward reverting, the seller never
          // pricing — it is still in the CDP spender, one hop earlier, and looking
          // only at the buyer reports "$0.50 owed to user" while the $0.50 sits in a
          // wallet nobody checked. Follow the money back down the path it took.
          if (short > DUST_USD) {
            try {
              const { txHash } = await wallet.refundUser(accountKey, short);
              console.log(`ACP refund of $${short} from the agent spender: ${txHash}`);
              sent = round6(sent + short);
              short = 0;
            } catch (spenderErr) {
              console.error(
                `ACP fallback refund from the spender failed: ` +
                  `${spenderErr instanceof Error ? spenderErr.message : String(spenderErr)}`,
              );
            }
          }

          if (short > DUST_USD) {
            // Base gas is sub-cent, so a gap this size is a real discrepancy, not
            // the paymaster — surface it instead of quietly keeping the money.
            console.error(`ACP refund to ${accountKey} short by $${short}`);
            settled.outcomeSummary += ` [refunded $${sent.toFixed(2)} of $${unspent.toFixed(2)} — $${short.toFixed(2)} owed to user]`;
          }
        } catch (err) {
          // The user is owed money — say so loudly and persist it in the job history
          // rather than let a silent catch bury it.
          const why = err instanceof Error ? err.message : String(err);
          console.error(`ACP refund of $${unspent} to ${accountKey} FAILED: ${why}`);
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

/**
 * A job that did not settle, attributed to the agent it was posted to.
 *
 * `counterpartyId` is what `appendAcpJob` writes and `trustScore()` reads, so an
 * "unknown" here spends the trust penalty on nobody: production showed "The job with
 * agent://unknown did not settle" while the confirmation the user had just approved
 * named `agent://0x3bc3…0fff`. The failure has to land on the counterparty that
 * failed, or the memory that decides who to hire next learns nothing from it.
 */
export function notSettled(job: AcpJobRequest, why: string, counterparty?: string): AcpJobResult {
  return {
    counterpartyId: counterparty ? `agent://${counterparty}` : "agent://unknown",
    jobType: job.jobType,
    outcomeSummary: `did not settle: ${why}`,
    rawResult: null,
    settled: false,
    amountUsd: 0,
  };
}
