import { z } from "zod";

/**
 * Sibyl Memory — the record.
 *
 * The authorization record is persisted as a **Sibyl Memory WARM entity**
 * (`ward.authorization` / `<ward_user_id>`); every mutation also appends a
 * **COLD journal event**. See `memory/README.md` for the tier map.
 *
 * The entity name is a `WardUserId` — an opaque principal, never a channel's own
 * account id. One user reaches Ward from Telegram, Discord or an MCP client and
 * lands on the same record; see `MULTI-CHANNEL.md`.
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

// --- identity ---

export const CHANNELS = ["telegram", "discord", "mcp"] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

/**
 * `ward_` + a 26-character Crockford base32 ULID.
 *
 * Deliberately **not** numeric. Telegram ids and Discord snowflakes are both bare
 * integers, so a numeric principal would let a Discord account silently resolve
 * onto a Telegram user's authorization record. A non-numeric principal makes that
 * class of bug unrepresentable rather than merely unlikely.
 */
export const WARD_USER_ID_RE = /^ward_[0-9A-HJKMNP-TV-Z]{26}$/;
export const wardUserIdSchema = z.string().regex(WARD_USER_ID_RE, "expected a ward_<ulid> user id");
export type WardUserId = z.infer<typeof wardUserIdSchema>;

/** A channel's own id for an account: an integer for Telegram/Discord, a token hash for MCP. */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const accountIdSchema = z.string().regex(ACCOUNT_ID_RE, "invalid channel account id");

/** How a channel account came to be attached to its principal. */
export const LINK_METHODS = [
  "first_contact",
  "link_code",
  "migration",
  "mcp_token",
  "wallet_signature",
] as const;
export const linkMethodSchema = z.enum(LINK_METHODS);
export type LinkMethod = z.infer<typeof linkMethodSchema>;

/**
 * The lookup index: one WARM entity per channel account, named
 * `<channel>:<account_id>`, whose body carries the principal it belongs to.
 * Resolving an inbound message is one read of this.
 */
export const wardIdentitySchema = z.object({
  ward_user_id: wardUserIdSchema,
  channel: channelSchema,
  account_id: accountIdSchema,
  linked_at: isoDatetime,
  linked_via: linkMethodSchema,
});
export type WardIdentity = z.infer<typeof wardIdentitySchema>;

/**
 * A checksummed-lowercase EVM address. Lowercased on the way in so the same wallet
 * is one owner however the user's tooling cased it.
 */
export const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const evmAddressSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.string().regex(EVM_ADDRESS_RE, "expected an 0x EVM address"));

/**
 * A wallet address whose control the user has proved by signature (Phase 14).
 *
 * Forward index, `ward.owner` / `<address>` → principal, mirroring `ward.identity`.
 * This is what makes wallet linking a *recovery* path and not just another way to
 * link: it answers "whose Ward is this address?" without the user reaching any chat
 * account they may have lost.
 */
export const verifiedOwnerSchema = z.object({
  ward_user_id: wardUserIdSchema,
  address: evmAddressSchema,
  verified_at: isoDatetime,
});
export type VerifiedOwner = z.infer<typeof verifiedOwnerSchema>;

/** The reverse index, `ward.owners` / `<ward_user_id>` — same reason as `ward.accounts`. */
export const ownerIndexSchema = z.object({
  ward_user_id: wardUserIdSchema,
  owners: z.array(verifiedOwnerSchema.omit({ ward_user_id: true })).default([]),
});
export type OwnerIndex = z.infer<typeof ownerIndexSchema>;

/**
 * An execution grant for one MCP token (Phase 16).
 *
 * The authority that lets a client execute rather than only propose — and it is
 * Ward's own Spend Permission idea applied one level up: capped, scoped, expiring,
 * revocable, granted from an authenticated DM. It can only ever narrow what the user
 * may already do, never widen it, so the spend comparison becomes
 * `min(grant, memory cap, on-chain allowance)`.
 *
 * Keyed by the **token's** hash rather than the principal, so a user can hold a
 * read-only token and a narrowly executing one at the same time and revoke either
 * without touching the other.
 */
export const mcpGrantSchema = z.object({
  ward_user_id: wardUserIdSchema,
  /** sha256 of the token — the same account id `ward.identity/mcp:<hash>` uses. */
  token_hash: z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest"),
  /** An allow-list. `x402_data_purchase` is a very different risk from `swap`. */
  action_types: z.array(actionTypeSchema).min(1),
  per_action_limit_usd: usdNonNegative,
  daily_limit_usd: usdNonNegative,
  granted_at: isoDatetime,
  granted_on: channelSchema,
  /** Required. A grant that never ends is a key, and this must not be a key. */
  expires_at: isoDatetime,
  revoked_at: isoDatetime.nullable().default(null),
});
export type McpGrant = z.infer<typeof mcpGrantSchema>;

/** Reverse index, `ward.mcp_grants` / `<ward_user_id>` — same reason as `ward.accounts`. */
export const mcpGrantIndexSchema = z.object({
  ward_user_id: wardUserIdSchema,
  grants: z.array(mcpGrantSchema.omit({ ward_user_id: true })).default([]),
});
export type McpGrantIndex = z.infer<typeof mcpGrantIndexSchema>;

/**
 * The outcome of an MCP-initiated spend (Phase 16.3).
 *
 * Settlement can take tens of seconds — long enough for a client to time out and
 * retry — so `ward_execute_action` returns one of these immediately and the client
 * polls it. It is a receipt, not an authorization: nothing here can cause a spend,
 * it only records one that was already gated.
 */
export const mcpReceiptSchema = z.object({
  id: nonEmpty,
  ward_user_id: wardUserIdSchema,
  token_hash: nonEmpty,
  status: z.enum(["pending", "done", "failed"]),
  request: nonEmpty,
  action_type: actionTypeSchema.nullable().default(null),
  amount_usd: usdNonNegative.nullable().default(null),
  tx_hash: z.string().nullable().default(null),
  message: z.string().default(""),
  created_at: isoDatetime,
  settled_at: isoDatetime.nullable().default(null),
});
export type McpReceipt = z.infer<typeof mcpReceiptSchema>;

export const linkedAccountSchema = wardIdentitySchema.omit({ ward_user_id: true });
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

/**
 * The reverse index, `ward.accounts` / `<ward_user_id>`. Neither backend can list
 * or query entities, so "which accounts does this principal own?" — needed for
 * `/whoami` and for the origin-channel notification on a new link — is kept as its
 * own document, written in the same lock as the forward entry.
 */
export const accountIndexSchema = z.object({
  ward_user_id: wardUserIdSchema,
  accounts: z.array(linkedAccountSchema),
});
export type AccountIndex = z.infer<typeof accountIndexSchema>;

// --- ledger entries ---

/** Appended after every successful execution. Never mutated. */
export const spendEntrySchema = z.object({
  ts: isoDatetime,
  amount_usd: usdNonNegative,
  action_type: actionTypeSchema,
  tx_hash: nonEmpty,
  idempotency_key: nonEmpty,
  /**
   * The MCP token that caused this spend, when one did (Phase 16). One ledger, two
   * authorities: the user's own cap counts every entry, a grant counts only its own.
   * Nullable and defaulted, so every entry written before Phase 16 still parses.
   */
  via_token: z.string().nullable().default(null),
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

/** Appended after every x402 purchase. Per-endpoint success/failure feeds a derived trust score. */
export const x402EntrySchema = z.object({
  ts: isoDatetime,
  url: nonEmpty,
  ok: z.boolean(),
  amount_usd: usdNonNegative,
});
export type X402Entry = z.infer<typeof x402EntrySchema>;

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
  x402_ledger: z.array(x402EntrySchema).default([]),
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
  /**
   * The stable key the wallet provider derives its CDP account names from
   * (`ward-user-<account_key>`). Minted once at connect and **never rewritten**:
   * the smart-account address is a function of this string, so rekeying it would
   * strand the user's funds and their granted spend permission at the old address.
   *
   * New records use the `WardUserId`. Records migrated from the Telegram-only
   * build keep their original Telegram id — which is the whole reason the field
   * exists rather than being derived from the principal.
   */
  account_key: nonEmpty,
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

export const x402InputSchema = x402EntrySchema.partial({ ts: true });
export type X402Input = z.input<typeof x402InputSchema>;

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
  "x402_purchase",
  "wallet_update",
  "identity_link",
  "identity_unlink",
  "identity_migrate",
  "mcp_grant",
  "mcp_grant_revoked",
  "owner_verified",
  "owner_revoked",
  "proposal",
] as const;
export const journalEventKindSchema = z.enum(JOURNAL_EVENT_KINDS);
export type JournalEventKind = z.infer<typeof journalEventKindSchema>;

export const journalEventSchema = z.object({
  ts: isoDatetime,
  user_id: wardUserIdSchema,
  /**
   * The channel the turn arrived on, where the writer knows it. Store-level writes
   * (a spend, a revocation) are made below the gateway and genuinely don't know,
   * so they record `null`; identity events always carry it.
   */
  channel: channelSchema.nullable().default(null),
  kind: journalEventKindSchema,
  summary: nonEmpty,
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type JournalEvent = z.infer<typeof journalEventSchema>;
