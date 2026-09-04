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
 * ── UNVERIFIED: the seller event names ────────────────────────────────────────
 * The buyer-side flow in `src/acp/virtuals.ts` is taken from the v2 README; the
 * seller-side event names are NOT confirmed against a live run. Rather than guess
 * silently, this logs every system event it sees and handles the ones we believe
 * exist. Run it, read the log, then narrow `WORK_EVENTS` / `ACCEPT_EVENTS` to
 * whatever actually arrives. Do not report the spike as working until a real job
 * goes created → escrowed → fulfilled → paid.
 */

/** Events that mean "the buyer wants the work done now". */
const WORK_EVENTS = ["job.submitted", "job.escrowed", "job.funded", "job.started"];
/** Events that mean "a buyer is offering you a job" — accept if the price is sane. */
const ACCEPT_EVENTS = ["job.requested", "job.created", "job.offered"];

const MIN_PRICE_USD = Number(process.env.COUNTERPARTY_MIN_USD ?? "0.01");

async function main(): Promise<void> {
  const walletId = process.env.ACP_WALLET_ID?.trim();
  const signerKey = process.env.ACP_SIGNER_KEY?.trim();
  if (!walletId || !signerKey) {
    throw new Error("set ACP_WALLET_ID and ACP_SIGNER_KEY in counterparty/.env — see README.md");
  }

  // Dynamic so this file typechecks in Ward's root project without the beta SDK
  // installed (the same escape hatch `src/acp/virtuals.ts` uses).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import("@virtuals-protocol/acp-node-v2" as string);
  } catch {
    throw new Error("run `npm i` inside counterparty/ first — @virtuals-protocol/acp-node-v2");
  }

  const { AcpAgent } = mod;
  const agent = await AcpAgent.create({ walletId, signerKey });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent.on("entry", async (session: any, entry: any) => {
    if (entry.kind !== "system") return;
    const type: string = entry.event?.type ?? "unknown";
    console.log(`[event] ${type}`);

    try {
      if (ACCEPT_EVENTS.includes(type)) {
        const priceUsd = Number(entry.event?.priceUsd ?? entry.event?.budgetUsd ?? 0);
        if (priceUsd && priceUsd < MIN_PRICE_USD) {
          console.log(`  rejecting: $${priceUsd} is under the $${MIN_PRICE_USD} minimum`);
          await session.reject?.("below minimum price");
          return;
        }
        console.log("  accepting");
        await session.accept?.();
        return;
      }

      if (WORK_EVENTS.includes(type)) {
        const subject = String(
          entry.event?.params?.ticker ?? entry.event?.job?.params?.ticker ?? "",
        );
        console.log(`  assessing ${subject}`);
        const report = await assess(subject);
        console.log(
          `  → ${report.band} (${report.risk_score}/100), ${report.flags.length} flag(s)`,
        );
        await session.deliver({ contentType: "deliverable", content: report });
        console.log("  delivered");
      }
    } catch (err) {
      // Never deliver a fabricated or degraded report to look successful — reject
      // the job and take the trust hit honestly.
      const why = err instanceof Error ? err.message : String(err);
      console.error(`  failed: ${why}`);
      await session.reject?.(why).catch(() => undefined);
    }
  });

  await agent.start();
  console.log(`counterparty listening — wallet ${walletId}, min $${MIN_PRICE_USD}/job`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
