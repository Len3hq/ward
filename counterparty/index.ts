import { base } from "@account-kit/infra";
import {
  AcpAgent,
  AssetToken,
  PrivyAlchemyEvmProviderAdapter,
} from "@virtuals-protocol/acp-node-v2";
import type { JobRoomEntry, JobSession } from "@virtuals-protocol/acp-node-v2";

import { assess } from "./score.ts";
import { sellerAction } from "./lifecycle.ts";

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
 * The seller has two moves, and missing either one deadlocks the job: `setBudget`
 * when the BUYER'S REQUIREMENT MESSAGE arrives (there is no negotiation — the seller
 * names the price), then `submit(deliverable)` once the buyer has funded it. There is
 * no accept step, and the deliverable is a **string**. The trigger is a `message`
 * entry, not a system event, which is the distinction that kept this broken; the
 * decision lives in `lifecycle.ts`, tested.
 */

const CHAIN_ID = 8453; // Base

/**
 * What this agent charges, in USDC.
 *
 * The seller names the price: ACP has no negotiation step here, so whatever is set
 * when the requirement arrives is what the buyer is asked to fund. Kept well under Ward's own
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
  // Last line of defence. Anything that escapes a handler still gets said out loud,
  // because a seller that stalls without explaining itself costs the buyer a real
  // timeout and a real trust penalty for a fault on this side.
  process.on("unhandledRejection", (reason) => {
    console.error(
      `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });
  process.on("uncaughtException", (err: Error) => {
    console.error(`uncaught exception: ${err.stack ?? err.message}`);
  });

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

  /** Jobs already priced, so the two triggers below cannot double-set a budget. */
  const priced = new Set<string>();

  /**
   * Name the price, once, while the job is still open.
   *
   * Both call sites are legitimate and either may fire first, so this is idempotent
   * on `jobId` and re-checks `status` — a second attempt after the buyer has funded
   * would be refused by the SDK anyway, and the refusal would read like a fault.
   */
  async function priceJob(session: JobSession, trigger: string): Promise<void> {
    if (priced.has(session.jobId)) return;
    if (session.status !== "open") {
      console.log(`[${session.jobId}] ${trigger}: status=${session.status}, nothing to price`);
      return;
    }
    priced.add(session.jobId);
    try {
      console.log(`[${session.jobId}] pricing on ${trigger}: $${PRICE_USD}`);
      await session.setBudget(AssetToken.usdc(PRICE_USD, session.chainId));
      console.log(`[${session.jobId}] budget set — waiting for the buyer to fund`);
    } catch (err) {
      // Let it be retried by the other trigger rather than stranding the job on one
      // transient failure.
      priced.delete(session.jobId);
      console.error(
        `[${session.jobId}] setBudget failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  agent.on("entry", (session: JobSession, entry: JobRoomEntry) => {
    // The handler is async and the emitter does not await it, so a rejection here is
    // an unhandled promise and the process just carries on in silence. That silence
    // is what made two rounds of this bug undiagnosable: `job.created` in the log and
    // no reason for the nothing that followed. Nothing thrown in `handle` escapes.
    void handle(session, entry).catch((err: unknown) => {
      console.error(
        `[${session.jobId}] handler threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    });
  });

  async function handle(session: JobSession, entry: JobRoomEntry): Promise<void> {
    // The routing decision lives in `lifecycle.ts`, pure and tested. It used to be
    // `if (entry.kind !== "system") return` inline here, which discarded the buyer's
    // requirement message — the very entry that tells a seller to name its price.
    const label = entry.kind === "system" ? entry.event.type : `${entry.kind}/${entry.contentType}`;
    const action = sellerAction(entry, session.status);
    console.log(`[${session.jobId}] ${label} → ${action} (status=${session.status})`);

    if (action === "price") {
      await priceJob(session, label);
      return;
    }
    if (action !== "deliver") return;

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
  }

  await agent.start();
  const address = await agent.getAddress();
  console.log(`counterparty listening as ${address} on chain ${CHAIN_ID}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
