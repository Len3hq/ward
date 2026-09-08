import { appendAcpJob, appendSpend, trustScore } from "../../memory/index.ts";
import { acpProvider, jobTrustDelta } from "../acp/index.ts";
import { validateExternalData } from "../agent/guardrails.ts";
import { renderAcpReport } from "./acp-report.ts";

/**
 * Run a confirmed ACP hire. The write-back is the point (plan §3.3): after the
 * job resolves, `appendAcpJob` records the outcome + a `trust_delta`, and the
 * next hire reads the re-derived `trustScore` first.
 */
export interface AcpRunInput {
  /** The principal — everything written to Sibyl Memory is keyed by this. */
  userId: string;
  /**
   * The wallet record's pinned `account_key` — escrow is funded by pulling on the
   * Spend Permission granted by *that* smart account. `null` when no wallet was ever
   * connected: the stub tolerates it, the real Virtuals path refuses.
   */
  accountKey: string | null;
  subject: string;
  budgetUsd: number;
  idempotencyKey: string;
  /** The MCP token that caused this job, when one did (Phase 16). */
  viaToken?: string | null;
}

export interface AcpRunOutput {
  ok: boolean;
  message: string;
  counterpartyId: string;
  trustBefore: number;
  trustAfter: number;
}

/** How many of the directory's listings to weigh before choosing. */
const CANDIDATES_TO_WEIGH = 10;

export interface AcpChoice {
  counterpartyId: string;
  trust: number;
  /** How many candidates were weighed — 1 means there was no choice to make. */
  considered: number;
  name?: string;
}

/**
 * Who to hire: the directory's listings, re-ranked by what Ward REMEMBERS.
 *
 * The marketplace ranks by its own criteria and knows nothing about how these agents
 * have treated this user. Ward does — that is what `acp_job_history` is for — so it
 * takes the directory's shortlist and prefers whoever has actually delivered before.
 * An unproven agent sits at the neutral prior, so a newcomer is tried when nobody has
 * a better record, and demoted the moment somebody earns one.
 *
 * Ties break on the marketplace's order, which is the right fallback: with nothing
 * remembered about either, its ranking is better information than none.
 */
export async function chooseCounterparty(userId: string, jobType: string): Promise<AcpChoice> {
  const provider = acpProvider();
  const candidates = await provider.candidates(jobType, CANDIDATES_TO_WEIGH);
  if (candidates.length === 0) {
    // Keep the old path's behaviour rather than inventing an error here: whatever
    // `preferredCounterparty` does about an empty directory, it does once.
    const id = await provider.preferredCounterparty(jobType);
    return { counterpartyId: id, trust: await trustScore(userId, id), considered: 0 };
  }

  const scored = await Promise.all(
    candidates.map(async (c, rank) => ({
      ...c,
      rank,
      trust: await trustScore(userId, c.id),
    })),
  );
  scored.sort((a, b) => b.trust - a.trust || a.rank - b.rank);
  const best = scored[0]!;
  return {
    counterpartyId: best.id,
    trust: best.trust,
    considered: scored.length,
    name: best.name,
  };
}

export async function runAcpJob(input: AcpRunInput): Promise<AcpRunOutput> {
  const provider = acpProvider();
  const chosen = await chooseCounterparty(input.userId, "token_risk");
  const counterpartyId = chosen.counterpartyId;
  const trustBefore = chosen.trust;

  const result = await provider.hire(input.accountKey, {
    jobType: "token_risk",
    subject: input.subject,
    maxUsd: input.budgetUsd,
    counterpartyId,
  });

  // Untrusted counterparty output — never reaches the LLM / a decision unwrapped.
  const validated = validateExternalData(result.rawResult, `acp:${result.counterpartyId}`);
  const delta = jobTrustDelta(result, validated.flagged);

  if (result.settled) {
    await appendSpend(input.userId, {
      action_type: "acp_job",
      amount_usd: result.amountUsd,
      tx_hash: result.txHash ?? "0x",
      idempotency_key: input.idempotencyKey,
      via_token: input.viaToken ?? null,
    });
  }

  await appendAcpJob(input.userId, {
    counterparty_id: result.counterpartyId,
    job_type: result.jobType,
    outcome_summary: validated.flagged
      ? `${result.outcomeSummary} [result failed validation: ${validated.reasons.join(", ")}]`
      : result.outcomeSummary,
    trust_delta: delta,
  });

  const trustAfter = await trustScore(input.userId, result.counterpartyId);

  // The thing the user actually bought. It used to be validated, written to memory
  // and then dropped, so the reply said "job completed" and nothing about what the
  // job found. `rawResult` is counterparty output and stays untrusted — it is
  // rendered as data, never interpreted, and `validated.flagged` still warns.
  const report = result.settled ? renderAcpReport(result.rawResult) : null;

  const message = result.settled
    ? [
        `Hired ${result.counterpartyId} to assess ${input.subject}.`,
        report ? "" : `Result: ${result.outcomeSummary}`,
        report ?? "",
        validated.flagged ? "(the result failed input validation — treat it with caution)" : "",
        `Trust in this counterparty: ${trustBefore.toFixed(2)} → ${trustAfter.toFixed(2)}.`,
      ]
        .filter(Boolean)
        .join("\n")
    : [
        `The job with ${result.counterpartyId} ${result.outcomeSummary}. Nothing was charged.`,
        `Trust: ${trustBefore.toFixed(2)} → ${trustAfter.toFixed(2)}.`,
      ].join("\n");

  return {
    ok: result.settled,
    message,
    counterpartyId: result.counterpartyId,
    trustBefore,
    trustAfter,
  };
}
