import { base } from "@account-kit/infra";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";
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
 * The seller's only move is `submit(deliverable)` on `job.funded` — there is no
 * accept step, and the deliverable is a **string**.
 */

const CHAIN_ID = 8453; // Base

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

    // Escrow is funded — do the work and submit. This is the seller's only move.
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
