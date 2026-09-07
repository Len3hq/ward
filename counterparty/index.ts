import { base } from "@account-kit/infra";
import {
  AcpAgent,
  AssetToken,
  PrivyAlchemyEvmProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type { JobRoomEntry, JobSession } from "@virtuals-protocol/acp-node-v2";

import { assess } from "./score.ts";

/**
 * The seller side of the ACP spike: a standalone agent that sells one thing —
 * a reproducible token-risk report (`score.ts`) — and settles on Base.
 *
 * This is a **separate agent with its own Virtuals registration and its own
 * wallet**. It is still run by the same team as Ward, which ACP.md requires be
 * disclosed plainly rather than presented as an independent third party. See
 * `counterparty/README.md`.
 *
 * Written against the installed SDK (`@virtuals-protocol/acp-node-v2` 0.1.12),
 * not guessed. Two things its README gets wrong, both confirmed against
 * `dist/`:
 *
 * - `AcpAgent.create` takes **`evmProvider`**, not `provider` — `clientFactory.js`
 *   destructures `{ evmProvider, solanaProvider }` and throws otherwise.
 * - `ViemProviderAdapter` is an abstract scaffold whose every method throws
 *   "Override in subclass". `PrivyAlchemyEvmProviderAdapter` is the only usable
 *   built-in EVM adapter.
 *
 * The seller has two moves, and missing either one deadlocks the job:
 * `setBudget` while the job is `open` (there is no negotiation — the seller names
 * the price), then `submit(deliverable)` once the buyer has funded it. There is no
 * accept step, and the deliverable is a **string**.
 */

const CHAIN_ID = 8453; // Base

/**
 * What this agent charges, in USDC.
 *
 * The seller names the price: ACP has no negotiation step here, so whatever is set
 * on `job.created` is what the buyer is asked to fund. Kept well under Ward's own
 * per-job budget so a job is never refused for being too dear — the buyer's gate
 * caps it independently, and the unspent remainder goes back to them.
 */
const PRICE_USD = Number(process.env.COUNTERPARTY_MIN_USD?.trim() || "0.01");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`set ${name} in counterparty/.env — see README.md`);
  return value;
}

/**
 * The buyer's requirement arrives as a `requirement` message, not on the event —
 * Ward sends `{ ticker }` via `createJobByOfferingName`. Read it off the session's
 * entries so a job hydrated on restart works the same as a live one.
 */
function subjectOf(session: JobSession): string {
  for (const entry of session.entries) {
    if (entry.kind !== "message" || entry.contentType !== "requirement") continue;
    try {
      const parsed: unknown = JSON.parse(entry.content);
      if (parsed && typeof parsed === "object") {
        const { ticker, subject, token } = parsed as Record<string, unknown>;
        const found = ticker ?? subject ?? token;
        if (typeof found === "string" && found.trim()) return found.trim();
      }
    } catch {
      if (entry.content.trim()) return entry.content.trim();
    }
  }
  throw new Error("no requirement message carrying a ticker or address");
}

async function main(): Promise<void> {
  const agent = await AcpAgent.create({
    evmProvider: await PrivyAlchemyEvmProviderAdapter.create({
      walletAddress: required("ACP_WALLET_ADDRESS") as `0x${string}`,
      walletId: required("ACP_WALLET_ID"),
      signerPrivateKey: required("ACP_SIGNER_KEY"),
      chains: [base],
      ...(process.env.ACP_BUILDER_CODE?.trim()
        ? { builderCode: process.env.ACP_BUILDER_CODE.trim() }
        : {}),
    }),
  });

  agent.on("entry", async (session: JobSession, entry: JobRoomEntry) => {
    if (entry.kind !== "system") return;
    const type = entry.event.type;
    console.log(`[${session.jobId}] ${type}`);

    // A new job is OPEN, and open is the seller's turn: the SDK's tool matrix gives
    // `setBudget` to the provider and only `wait`/`fund` to the client, and the tool's
    // own description is blunt about it — "a budget MUST be set before the buyer can
    // fund". Skipping it deadlocks the job: Ward waits for `budget.set` before
    // funding, this side waits for `job.funded` before working, and neither moves.
    // Observed in production — job 77352 sat in `open` until Ward's 180s timeout,
    // and the counterparty took a trust penalty for a stall it was not part of.
    if (type === "job.created") {
      // The SDK's own view of whose turn it is, rather than a second guess at the
      // state machine — this also makes a session hydrated after a restart safe.
      if (!session.availableTools().some((tool) => tool.name === "setBudget")) {
        console.log("  not ours to price right now — waiting");
        return;
      }
      try {
        console.log(`  setting budget $${PRICE_USD}`);
        await session.setBudget(AssetToken.usdc(PRICE_USD, session.chainId));
        console.log("  budget set — waiting for the buyer to fund");
      } catch (err) {
        console.error(`  setBudget failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // Escrow is funded — do the work and submit.
    if (type !== "job.funded") return;

    try {
      const subject = subjectOf(session);
      console.log(`  assessing ${subject}`);
      const report = await assess(subject);
      console.log(`  → ${report.band} (${report.risk_score}/100), ${report.flags.length} flag(s)`);
      await session.submit(JSON.stringify(report));
      console.log("  submitted");
    } catch (err) {
      // Never submit a fabricated or degraded report to look successful — reject
      // the job and take the trust hit honestly.
      const why = err instanceof Error ? err.message : String(err);
      console.error(`  failed: ${why}`);
      await session
        .reject(why)
        .catch((e: unknown) => console.error(`  reject failed: ${String(e)}`));
    }
  });

  await agent.start();
  const address = await agent.getAddress();
  console.log(`counterparty listening as ${address} on chain ${CHAIN_ID}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
