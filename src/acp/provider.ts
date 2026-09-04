import { loadConfig } from "../config.ts";
import { StubAcpProvider } from "./stub.ts";
import { VirtualsAcpProvider } from "./virtuals.ts";

/**
 * Virtuals ACP counterparty market. Ward hires another agent to assess a token's
 * risk, pays via escrow that settles on Base, and **remembers whether the
 * counterparty was worth trusting** (the write-back in `execution/acp.ts` is the
 * load-bearing part, not this).
 *
 * What the counterparty sells is a normalization + scoring layer over public
 * token-security data, with cited sources and a reproducible score — not an
 * independent audit, and not work a data endpoint couldn't do. The trust loop is
 * the point, not the depth of the analysis. See ACP.md.
 *
 * Two implementations:
 * - `virtuals` (`acp/virtuals.ts`) — the real path, `@virtuals-protocol/acp-node-v2`.
 *   **Hard go/no-go** — if a job doesn't settle end-to-end (created → escrowed →
 *   fulfilled → paid), cut it cleanly, never fake it. See `ACP.md`.
 * - `stub` (`acp/stub.ts`) — a **clearly-labelled simulation** of a counterparty,
 *   for the trust-loop tests and for demoing the memory story. Never presented as
 *   a real third party.
 */

export interface AcpJobRequest {
  jobType: "token_risk";
  /** Token symbol or address to assess. */
  subject: string;
  /** Escrow budget cap, in USD. */
  maxUsd: number;
}

export interface AcpJobResult {
  counterpartyId: string;
  jobType: string;
  /** Short human summary for `acp_job_history.outcome_summary`. */
  outcomeSummary: string;
  /** The counterparty's raw output — UNTRUSTED, runs through `validateExternalData`. */
  rawResult: unknown;
  /** true only when the job settled end-to-end. */
  settled: boolean;
  /** Escrow settlement tx on Base. */
  txHash?: string;
  amountUsd: number;
}

export interface AcpProvider {
  readonly kind: "virtuals" | "stub";
  /** The counterparty a hire would use — read its trust score BEFORE hiring. */
  preferredCounterparty(jobType: string): Promise<string>;
  /** Post a job and drive it to resolution. Never throws for a normal "did not settle" — sets `settled: false`. */
  hire(tgId: string, job: AcpJobRequest): Promise<AcpJobResult>;
}

let cached: AcpProvider | null = null;

export function acpProvider(): AcpProvider {
  if (cached) return cached;
  cached = loadConfig().acpMode === "virtuals" ? new VirtualsAcpProvider() : new StubAcpProvider();
  return cached;
}

/** Test hook. */
export function resetAcpProvider(): void {
  cached = null;
}
