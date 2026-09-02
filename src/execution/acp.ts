import { appendAcpJob, appendSpend, trustScore } from "../../memory/index.ts";
import { acpProvider, jobTrustDelta } from "../acp/index.ts";
import { validateExternalData } from "../agent/guardrails.ts";

/**
 * Run a confirmed ACP hire. The write-back is the point (plan §3.3): after the
 * job resolves, `appendAcpJob` records the outcome + a `trust_delta`, and the
 * next hire reads the re-derived `trustScore` first.
 */
export interface AcpRunInput {
  tgId: string;
  subject: string;
  budgetUsd: number;
  idempotencyKey: string;
}

export interface AcpRunOutput {
  ok: boolean;
  message: string;
  counterpartyId: string;
  trustBefore: number;
  trustAfter: number;
}

export async function runAcpJob(input: AcpRunInput): Promise<AcpRunOutput> {
  const provider = acpProvider();
  const counterpartyId = await provider.preferredCounterparty("token_risk");
  const trustBefore = await trustScore(input.tgId, counterpartyId);

  const result = await provider.hire(input.tgId, {
    jobType: "token_risk",
    subject: input.subject,
    maxUsd: input.budgetUsd,
  });

  // Untrusted counterparty output — never reaches the LLM / a decision unwrapped.
  const validated = validateExternalData(result.rawResult, `acp:${result.counterpartyId}`);
  const delta = jobTrustDelta(result, validated.flagged);

  if (result.settled) {
    await appendSpend(input.tgId, {
      action_type: "acp_job",
      amount_usd: result.amountUsd,
      tx_hash: result.txHash ?? "0x",
      idempotency_key: input.idempotencyKey,
    });
  }

  await appendAcpJob(input.tgId, {
    counterparty_id: result.counterpartyId,
    job_type: result.jobType,
    outcome_summary: validated.flagged
      ? `${result.outcomeSummary} [result failed validation: ${validated.reasons.join(", ")}]`
      : result.outcomeSummary,
    trust_delta: delta,
  });

  const trustAfter = await trustScore(input.tgId, result.counterpartyId);

  const message = result.settled
    ? [
        `Hired ${result.counterpartyId} to assess ${input.subject}.`,
        `Result: ${result.outcomeSummary}`,
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
