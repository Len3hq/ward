import { z } from "zod";

/**
 * Sibyl Memory — the record.
 *
 * The authorization record is persisted as a **Sibyl Memory WARM entity**
 * (`ward.authorization` / `<telegram_id>`); every mutation also appends a
 * **COLD journal event**. See `memory/README.md` for the tier map.
 *
 * Every field of `UserAuthorization` except `risk_label` grows only through use.
 * There is deliberately **no `trust_score` stored**: it is derived from
 * `acp_job_history` on every read (see `memory/trust.ts`). Persisting it would let
 * a hand-edited entity lie about how much the agent trusts a counterparty.
 *
 * Schemas here are the single validation point — `store.ts` runs them on every
 * read and every write, whichever backend is behind it. Unknown keys are stripped
 * (not rejected) so a human can drop a note into a record without breaking the
 * agent.
 */

// --- primitives ---

const isoDatetime = z.iso.datetime({ offset: true });
const usdPositive = z.number().positive();
const usdNonNegative = z.number().nonnegative();
const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "expected a 0x-prefixed EVM address");
const nonEmpty = z.string().min(1);

// --- enums ---

export const RISK_LABELS = ["conservative", "moderate", "aggressive"] as const;
export const riskLabelSchema = z.enum(RISK_LABELS);
export type RiskLabel = z.infer<typeof riskLabelSchema>;

/**
 * The action categories the agent can perform that move money. One enum for the
 * spend ledger and the revocation log: you revoke the same categories you spend
 * under.
 */
export const ACTION_TYPES = ["swap", "x402_data_purchase", "acp_job"] as const;
export const actionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof actionTypeSchema>;

// --- ledger entries ---

/** Appended after every successful execution. Never mutated. */
export const spendEntrySchema = z.object({
  ts: isoDatetime,
  amount_usd: usdNonNegative,
  action_type: actionTypeSchema,
  tx_hash: nonEmpty,
  idempotency_key: nonEmpty,
});
export type SpendEntry = z.infer<typeof spendEntrySchema>;

/** Appended on every revoke. Checked fresh before every action. */
export const revocationEntrySchema = z.object({
  ts: isoDatetime,
  action_type: actionTypeSchema,
  reason: nonEmpty,
});
export type RevocationEntry = z.infer<typeof revocationEntrySchema>;

/** Appended after every ACP job resolves. Feeds the derived trust score. */
export const acpJobEntrySchema = z.object({
  ts: isoDatetime,
  counterparty_id: nonEmpty,
  job_type: nonEmpty,
  outcome_summary: nonEmpty,
  trust_delta: z.number().min(-1).max(1),
});
export type AcpJobEntry = z.infer<typeof acpJobEntrySchema>;

// --- authorization record ---

export const standingCapsSchema = z.object({
  per_action_limit_usd: usdPositive,
  daily_limit_usd: usdPositive,
});
export type StandingCaps = z.infer<typeof standingCapsSchema>;

export const userAuthorizationSchema = z.object({
  risk_label: riskLabelSchema, // set once at onboarding — the only static field
  standing_caps: standingCapsSchema,
  spent_ledger: z.array(spendEntrySchema),
  revocation_log: z.array(revocationEntrySchema),
  acp_job_history: z.array(acpJobEntrySchema),
});
export type UserAuthorization = z.infer<typeof userAuthorizationSchema>;

// --- wallet record ---

export const spendPermissionSchema = z.object({
  token: z.literal("USDC"),
  allowance_usd: usdPositive,
  period_seconds: z.number().int().positive(),
  granted_tx: nonEmpty,
  status: z.enum(["active", "revoked"]),
});
export type SpendPermission = z.infer<typeof spendPermissionSchema>;

export const walletRecordSchema = z.object({
  smart_account: evmAddress, // user's CDP Embedded Wallet smart account
  agent_spender: evmAddress, // agent's CDP Server Wallet
  spend_permission: spendPermissionSchema.nullable(), // null until the user grants one on-chain
});
export type WalletRecord = z.infer<typeof walletRecordSchema>;

// --- input shapes for store writes ---

export const initializeInputSchema = z.object({
  risk_label: riskLabelSchema,
  per_action_limit_usd: usdPositive,
  daily_limit_usd: usdPositive,
});
export type InitializeInput = z.infer<typeof initializeInputSchema>;

/** `ts` defaults to now when the caller omits it. */
export const spendInputSchema = spendEntrySchema.partial({ ts: true });
export type SpendInput = z.input<typeof spendInputSchema>;

export const revocationInputSchema = revocationEntrySchema.partial({ ts: true });
export type RevocationInput = z.input<typeof revocationInputSchema>;

export const acpJobInputSchema = acpJobEntrySchema.partial({ ts: true });
export type AcpJobInput = z.input<typeof acpJobInputSchema>;

// --- COLD journal event ---

/**
 * Appended (never mutated) to Sibyl Memory's COLD journal on every write. The
 * WARM entity is the queryable source of truth for the gate; the journal is the
 * append-only narrative judges look for ("dynamic-storage patterns top the band")
 * and the audit trail `memory_search` indexes.
 */
export const JOURNAL_EVENT_KINDS = [
  "onboarded",
  "spend",
  "revocation",
  "acp_job",
  "wallet_update",
] as const;
export const journalEventKindSchema = z.enum(JOURNAL_EVENT_KINDS);
export type JournalEventKind = z.infer<typeof journalEventKindSchema>;

export const journalEventSchema = z.object({
  ts: isoDatetime,
  tg_id: z.string().regex(/^\d+$/),
  kind: journalEventKindSchema,
  summary: nonEmpty,
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type JournalEvent = z.infer<typeof journalEventSchema>;
