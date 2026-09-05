import { createHash } from "node:crypto";

import type { AcpJobRequest, AcpJobResult, AcpProvider } from "./provider.ts";

/**
 * A **clearly-labelled simulation** of an ACP counterparty. Used by the trust-loop
 * tests and to demo the memory story (post job → validate result → write trust →
 * next hire reads it). It is NOT a real third party and must never be shown as
 * one in a submission — the real path is `acp/virtuals.ts`, gated on the go/no-go
 * spike (`ACP.md`).
 */

const COUNTERPARTY = "agent://ward-analyst.stub";

export class StubAcpProvider implements AcpProvider {
  readonly kind = "stub" as const;

  /** Test observability — a hire must never land here after a refusal. */
  readonly calls: string[] = [];

  async preferredCounterparty(): Promise<string> {
    return COUNTERPARTY;
  }

  async hire(accountKey: string | null, job: AcpJobRequest): Promise<AcpJobResult> {
    this.calls.push("hire");
    // A deterministic, plausible token-risk assessment.
    const seed = parseInt(createHash("sha256").update(job.subject).digest("hex").slice(0, 8), 16);
    const score = seed % 100;
    const flags: string[] = [];
    if (score < 30) flags.push("mint authority not renounced", "top-10 holders > 60%");
    else if (score < 55) flags.push("LP lock expires in < 30 days");

    const rawResult = {
      subject: job.subject,
      risk_score: score,
      band: score < 30 ? "high" : score < 55 ? "elevated" : "low",
      flags,
      note: "[SIMULATED counterparty result — not a real ACP job]",
    };

    return {
      counterpartyId: COUNTERPARTY,
      jobType: job.jobType,
      outcomeSummary: `risk ${rawResult.band} (${score}/100)${flags.length ? `, flags: ${flags.join("; ")}` : ""}`,
      rawResult,
      settled: true,
      txHash: `0x${createHash("sha256").update(`acp-${accountKey}-${job.subject}-${Date.now()}`).digest("hex")}`,
      amountUsd: job.maxUsd,
    };
  }
}
