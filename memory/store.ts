import { z } from "zod";

import { backend } from "./backend.ts";
import {
  accountIdSchema,
  accountIndexSchema,
  acpJobInputSchema,
  channelSchema,
  initializeInputSchema,
  journalEventSchema,
  revocationInputSchema,
  spendInputSchema,
  userAuthorizationSchema,
  walletRecordSchema,
  wardIdentitySchema,
  WARD_USER_ID_RE,
  x402InputSchema,
  type AccountIndex,
  type AcpJobInput,
  type ActionType,
  type Channel,
  type InitializeInput,
  type JournalEvent,
  type JournalEventKind,
  type LinkedAccount,
  type LinkMethod,
  type RevocationInput,
  type SpendInput,
  type UserAuthorization,
  type WalletRecord,
  type WardIdentity,
  type X402Input,
} from "./schema.ts";
import { computeTrustScore } from "./trust.ts";

/**
 * Sibyl Memory — the read/write API the agent, router, and execution gate depend
 * on. See `memory/README.md` for the field → function map.
 *
 * Persistence goes through a `MemoryBackend` (`memory/backend.ts`): Sibyl Memory
 * over MCP by default, a JSON-file backend for tests. This module owns every
 * schema check and all domain logic; the backend only moves opaque documents.
 *
 * The authorization record lives in one WARM entity (`ward.authorization` /
 * `<ward_user_id>`) that is the queryable source of truth for the gate. Every
 * mutation also appends a COLD journal event — the append-only narrative and
 * audit trail.
 *
 * Every function here is keyed by a `WardUserId` — an opaque principal, never a
 * channel's account id. `src/identity/` maps an inbound Telegram / Discord / MCP
 * account onto one; this module never sees a channel. See `MULTI-CHANNEL.md`.
 *
 * Writes for one user are serialised by an in-process lock so a read-modify-write
 * cannot lose an appended ledger row under concurrent Telegram turns.
 */

const AUTHORIZATION = "ward.authorization";
const WALLET = "ward.wallet";
const IDENTITY = "ward.identity";
const ACCOUNTS = "ward.accounts";

// --- helpers ---

/**
 * Reject anything that is not a `WardUserId` before it reaches a key or a path.
 *
 * The strictness is the point: a bare integer must never be accepted here. Telegram
 * ids and Discord snowflakes are both integers, so a lenient normalizer would let a
 * Discord account resolve onto a Telegram user's authorization record. Channel
 * accounts are translated to a principal by `src/identity/` and nowhere else.
 */
function normalizeUserId(userId: string): string {
  const id = String(userId);
  if (!WARD_USER_ID_RE.test(id)) {
    throw new Error(
      `not a Ward user id: ${JSON.stringify(userId)} — resolve the channel account ` +
        `through src/identity/ first (expected ward_<ulid>)`,
    );
  }
  return id;
}

/** `ward.identity` entity name for one channel account. */
function identityName(channel: Channel, accountId: string): string {
  return `${channelSchema.parse(channel)}:${accountIdSchema.parse(accountId)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function journal(
  userId: string,
  kind: JournalEventKind,
  summary: string,
  detail: Record<string, unknown> = {},
  channel: Channel | null = null,
): Promise<void> {
  const event: JournalEvent = journalEventSchema.parse({
    ts: nowIso(),
    user_id: userId,
    channel,
    kind,
    summary,
    detail,
  });
  await backend().appendEvent(event);
}

/**
 * Journal an event from outside this module — `src/identity/` writes link and
 * migration events, and unlike a spend it *does* know which channel it happened on.
 */
export async function appendJournalEvent(
  userId: string,
  kind: JournalEventKind,
  summary: string,
  detail: Record<string, unknown> = {},
  channel: Channel | null = null,
): Promise<void> {
  await journal(normalizeUserId(userId), kind, summary, detail, channel);
}

// --- authorization: read ---

/** `null` when the record does not exist — the gate's trigger to refuse. */
export async function read(userId: string): Promise<UserAuthorization | null> {
  const raw = await backend().getEntity(AUTHORIZATION, normalizeUserId(userId));
  if (raw === null || raw === undefined) return null;
  return userAuthorizationSchema.parse(raw);
}

async function readOrThrow(userId: string): Promise<UserAuthorization> {
  const record = await read(userId);
  if (record === null) throw new Error(`no authorization record for ${normalizeUserId(userId)}`);
  return record;
}

// --- authorization: writes ---

/** Onboarding writes once. Throws if a record already exists. */
export async function initialize(
  userId: string,
  input: InitializeInput,
): Promise<UserAuthorization> {
  const { risk_label, per_action_limit_usd, daily_limit_usd } = initializeInputSchema.parse(input);
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    if ((await read(id)) !== null) {
      throw new Error(`authorization already initialized for ${id}`);
    }
    const record = userAuthorizationSchema.parse({
      risk_label,
      standing_caps: { per_action_limit_usd, daily_limit_usd },
      spent_ledger: [],
      revocation_log: [],
      acp_job_history: [],
    });
    await backend().putEntity(AUTHORIZATION, id, record);
    await journal(
      id,
      "onboarded",
      `onboarded ${risk_label}: $${per_action_limit_usd}/action, $${daily_limit_usd}/day`,
      {
        risk_label,
        per_action_limit_usd,
        daily_limit_usd,
      },
    );
    return record;
  });
}

/** Append-only, idempotent on `idempotency_key`. A repeat key is a no-op. */
export async function appendSpend(userId: string, entry: SpendInput): Promise<UserAuthorization> {
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    const record = await readOrThrow(id);
    if (record.spent_ledger.some((e) => e.idempotency_key === entry.idempotency_key)) {
      return record;
    }
    const row = spendInputSchema.parse({ ts: nowIso(), ...entry });
    const next = userAuthorizationSchema.parse({
      ...record,
      spent_ledger: [...record.spent_ledger, row],
    });
    await backend().putEntity(AUTHORIZATION, id, next);
    await journal(id, "spend", `${row.action_type} $${row.amount_usd} (${row.tx_hash})`, row);
    return next;
  });
}

/** Append-only. `isRevoked` reads this fresh before every action. */
export async function appendRevocation(
  userId: string,
  entry: RevocationInput,
): Promise<UserAuthorization> {
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    const record = await readOrThrow(id);
    const row = revocationInputSchema.parse({ ts: nowIso(), ...entry });
    const next = userAuthorizationSchema.parse({
      ...record,
      revocation_log: [...record.revocation_log, row],
    });
    await backend().putEntity(AUTHORIZATION, id, next);
    await journal(id, "revocation", `revoked ${row.action_type}: ${row.reason}`, row);
    return next;
  });
}

/**
 * Fresh read every call — a mid-session revocation takes effect immediately, not
 * at the next session start. A missing record is not "revoked" (the gate refuses
 * earlier, on the missing record itself).
 */
export async function isRevoked(userId: string, actionType: ActionType): Promise<boolean> {
  const record = await read(userId);
  if (record === null) return false;
  return record.revocation_log.some((r) => r.action_type === actionType);
}

/** Append-only. Appended after every ACP job resolves. */
export async function appendAcpJob(userId: string, entry: AcpJobInput): Promise<UserAuthorization> {
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    const record = await readOrThrow(id);
    const row = acpJobInputSchema.parse({ ts: nowIso(), ...entry });
    const next = userAuthorizationSchema.parse({
      ...record,
      acp_job_history: [...record.acp_job_history, row],
    });
    await backend().putEntity(AUTHORIZATION, id, next);
    await journal(
      id,
      "acp_job",
      `acp job ${row.job_type} with ${row.counterparty_id} (Δtrust ${row.trust_delta})`,
      row,
    );
    return next;
  });
}

/** Append-only. Appended after every x402 purchase attempt (ok or failed). */
export async function appendX402(userId: string, entry: X402Input): Promise<UserAuthorization> {
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    const record = await readOrThrow(id);
    const row = x402InputSchema.parse({ ts: nowIso(), ...entry });
    const next = userAuthorizationSchema.parse({
      ...record,
      x402_ledger: [...record.x402_ledger, row],
    });
    await backend().putEntity(AUTHORIZATION, id, next);
    await journal(
      id,
      "x402_purchase",
      `x402 ${row.ok ? "ok" : "failed"} ${row.url} ($${row.amount_usd})`,
      row,
    );
    return next;
  });
}

// --- authorization: derived reads ---

/** Recency-weighted trust for one counterparty, derived from `acp_job_history`. */
export async function trustScore(userId: string, counterpartyId: string): Promise<number> {
  const record = await read(userId);
  const jobs = (record?.acp_job_history ?? []).filter((j) => j.counterparty_id === counterpartyId);
  return computeTrustScore(jobs);
}

/**
 * Recency-weighted trust for one x402 endpoint, derived from `x402_ledger`. `ok`
 * maps to +1 / -1; unproven endpoints return the neutral prior.
 */
export async function endpointTrust(userId: string, url: string): Promise<number> {
  const record = await read(userId);
  const rows = (record?.x402_ledger ?? []).filter((e) => e.url === url);
  return computeTrustScore(
    rows.map((e) => ({
      ts: e.ts,
      counterparty_id: url,
      job_type: "x402",
      outcome_summary: e.ok ? "ok" : "failed",
      trust_delta: e.ok ? 0.5 : -0.5,
    })),
  );
}

/**
 * Sum of `spent_ledger` rows in the current UTC day. Pass `now` to test the day
 * boundary. Returns 0 for a missing record.
 */
export async function spentToday(userId: string, now: Date = new Date()): Promise<number> {
  const record = await read(userId);
  if (record === null) return 0;

  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEnd = dayStart + 86_400_000;

  const total = record.spent_ledger.reduce((sum, entry) => {
    const t = Date.parse(entry.ts);
    return t >= dayStart && t < dayEnd ? sum + entry.amount_usd : sum;
  }, 0);

  return round2(total);
}

// --- wallet ---

/** `null` until the user connects a wallet. */
export async function readWallet(userId: string): Promise<WalletRecord | null> {
  const raw = await backend().getEntity(WALLET, normalizeUserId(userId));
  if (raw === null || raw === undefined) return null;
  return walletRecordSchema.parse(raw);
}

/** Full replace (the wallet record is mutated as permission status changes, not appended). */
export async function writeWallet(userId: string, record: WalletRecord): Promise<WalletRecord> {
  const validated = walletRecordSchema.parse(record);
  const id = normalizeUserId(userId);
  return withLock(id, async () => {
    await backend().putEntity(WALLET, id, validated);
    await journal(
      id,
      "wallet_update",
      `wallet ${validated.smart_account} · permission ${validated.spend_permission?.status ?? "none"}`,
      {
        smart_account: validated.smart_account,
        agent_spender: validated.agent_spender,
        spend_permission: validated.spend_permission,
      },
    );
    return validated;
  });
}

// --- identity (the channel-account → principal index) ---

/**
 * Resolve one channel account to its principal. `null` when the account has never
 * been seen — which is `src/identity/`'s trigger to mint a new principal or to
 * refuse, depending on the channel.
 */
export async function readIdentity(
  channel: Channel,
  accountId: string,
): Promise<WardIdentity | null> {
  const raw = await backend().getEntity(IDENTITY, identityName(channel, accountId));
  if (raw === null || raw === undefined) return null;
  return wardIdentitySchema.parse(raw);
}

/** Every channel account attached to one principal. Empty array when there are none. */
export async function readAccounts(userId: string): Promise<LinkedAccount[]> {
  const raw = await backend().getEntity(ACCOUNTS, normalizeUserId(userId));
  if (raw === null || raw === undefined) return [];
  return accountIndexSchema.parse(raw).accounts;
}

/**
 * Attach a channel account to a principal: writes the forward entry and the reverse
 * index under one lock.
 *
 * The forward entry is written **last**, so a crashed or re-run migration leaves the
 * account unresolved rather than resolved to a half-built principal — and a re-run
 * that finds the forward entry already present can safely no-op.
 */
export async function writeIdentity(
  userId: string,
  channel: Channel,
  accountId: string,
  linkedVia: LinkMethod,
): Promise<WardIdentity> {
  const id = normalizeUserId(userId);
  const identity: WardIdentity = wardIdentitySchema.parse({
    ward_user_id: id,
    channel,
    account_id: accountId,
    linked_at: nowIso(),
    linked_via: linkedVia,
  });

  return withLock(id, async () => {
    const accounts = await readAccounts(id);
    const others = accounts.filter(
      (a) => !(a.channel === identity.channel && a.account_id === identity.account_id),
    );
    const index: AccountIndex = accountIndexSchema.parse({
      ward_user_id: id,
      accounts: [
        ...others,
        { channel, account_id: accountId, linked_at: identity.linked_at, linked_via: linkedVia },
      ],
    });
    await backend().putEntity(ACCOUNTS, id, index);
    await backend().putEntity(IDENTITY, identityName(channel, accountId), identity);
    return identity;
  });
}

/** Detach a channel account. The principal and its authorization record are untouched. */
export async function forgetIdentity(
  userId: string,
  channel: Channel,
  accountId: string,
): Promise<void> {
  const id = normalizeUserId(userId);
  await withLock(id, async () => {
    await backend().forgetEntity(IDENTITY, identityName(channel, accountId), "unlinked");
    const accounts = await readAccounts(id);
    const index: AccountIndex = accountIndexSchema.parse({
      ward_user_id: id,
      accounts: accounts.filter((a) => !(a.channel === channel && a.account_id === accountId)),
    });
    await backend().putEntity(ACCOUNTS, id, index);
  });
}

// --- conversation summary (Sibyl Memory HOT state) ---

const conversationSchema = z.object({
  summary: z.string(),
  turn_count: z.number().int().nonnegative(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type ConversationMemory = z.infer<typeof conversationSchema>;

function conversationKey(userId: string): string {
  return `ward.conversation.${normalizeUserId(userId)}`;
}

/** The rolling episodic summary — accumulates turn over turn, survives `/newsession`. */
export async function readConversation(userId: string): Promise<ConversationMemory | null> {
  const raw = await backend().getState(conversationKey(userId));
  if (raw === null || raw === undefined) return null;
  return conversationSchema.parse(raw);
}

export async function writeConversation(
  userId: string,
  summary: string,
  turnCount: number,
): Promise<ConversationMemory> {
  const value = conversationSchema.parse({
    summary,
    turn_count: turnCount,
    updated_at: nowIso(),
  });
  await backend().setState(conversationKey(userId), value);
  return value;
}
