import { z } from "zod";

import { backend } from "./backend.ts";
import {
  acpJobInputSchema,
  initializeInputSchema,
  journalEventSchema,
  revocationInputSchema,
  spendInputSchema,
  userAuthorizationSchema,
  walletRecordSchema,
  x402InputSchema,
  type AcpJobInput,
  type ActionType,
  type InitializeInput,
  type JournalEvent,
  type JournalEventKind,
  type RevocationInput,
  type SpendInput,
  type UserAuthorization,
  type WalletRecord,
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
 * `<telegram_id>`) that is the queryable source of truth for the gate. Every
 * mutation also appends a COLD journal event — the append-only narrative and
 * audit trail.
 *
 * Writes for one user are serialised by an in-process lock so a read-modify-write
 * cannot lose an appended ledger row under concurrent Telegram turns.
 */

const AUTHORIZATION = "ward.authorization";
const WALLET = "ward.wallet";

// --- helpers ---

/** Telegram ids are unsigned integers; reject anything else before it reaches a key/path. */
function normalizeTgId(tgId: number | string): string {
  const id = String(tgId);
  if (!/^\d+$/.test(id)) throw new Error(`invalid telegram id: ${JSON.stringify(tgId)}`);
  return id;
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
  tgId: string,
  kind: JournalEventKind,
  summary: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const event: JournalEvent = journalEventSchema.parse({
    ts: nowIso(),
    tg_id: tgId,
    kind,
    summary,
    detail,
  });
  await backend().appendEvent(event);
}

// --- authorization: read ---

/** `null` when the record does not exist — the gate's trigger to refuse. */
export async function read(tgId: number | string): Promise<UserAuthorization | null> {
  const raw = await backend().getEntity(AUTHORIZATION, normalizeTgId(tgId));
  if (raw === null || raw === undefined) return null;
  return userAuthorizationSchema.parse(raw);
}

async function readOrThrow(tgId: number | string): Promise<UserAuthorization> {
  const record = await read(tgId);
  if (record === null) throw new Error(`no authorization record for ${normalizeTgId(tgId)}`);
  return record;
}

// --- authorization: writes ---

/** Onboarding writes once. Throws if a record already exists. */
export async function initialize(
  tgId: number | string,
  input: InitializeInput,
): Promise<UserAuthorization> {
  const { risk_label, per_action_limit_usd, daily_limit_usd } = initializeInputSchema.parse(input);
  const id = normalizeTgId(tgId);
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
export async function appendSpend(
  tgId: number | string,
  entry: SpendInput,
): Promise<UserAuthorization> {
  const id = normalizeTgId(tgId);
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
  tgId: number | string,
  entry: RevocationInput,
): Promise<UserAuthorization> {
  const id = normalizeTgId(tgId);
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
export async function isRevoked(tgId: number | string, actionType: ActionType): Promise<boolean> {
  const record = await read(tgId);
  if (record === null) return false;
  return record.revocation_log.some((r) => r.action_type === actionType);
}

/** Append-only. Appended after every ACP job resolves. */
export async function appendAcpJob(
  tgId: number | string,
  entry: AcpJobInput,
): Promise<UserAuthorization> {
  const id = normalizeTgId(tgId);
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
export async function appendX402(
  tgId: number | string,
  entry: X402Input,
): Promise<UserAuthorization> {
  const id = normalizeTgId(tgId);
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
export async function trustScore(tgId: number | string, counterpartyId: string): Promise<number> {
  const record = await read(tgId);
  const jobs = (record?.acp_job_history ?? []).filter((j) => j.counterparty_id === counterpartyId);
  return computeTrustScore(jobs);
}

/**
 * Recency-weighted trust for one x402 endpoint, derived from `x402_ledger`. `ok`
 * maps to +1 / -1; unproven endpoints return the neutral prior.
 */
export async function endpointTrust(tgId: number | string, url: string): Promise<number> {
  const record = await read(tgId);
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
export async function spentToday(tgId: number | string, now: Date = new Date()): Promise<number> {
  const record = await read(tgId);
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
export async function readWallet(tgId: number | string): Promise<WalletRecord | null> {
  const raw = await backend().getEntity(WALLET, normalizeTgId(tgId));
  if (raw === null || raw === undefined) return null;
  return walletRecordSchema.parse(raw);
}

/** Full replace (the wallet record is mutated as permission status changes, not appended). */
export async function writeWallet(
  tgId: number | string,
  record: WalletRecord,
): Promise<WalletRecord> {
  const validated = walletRecordSchema.parse(record);
  const id = normalizeTgId(tgId);
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

// --- conversation summary (Sibyl Memory HOT state) ---

const conversationSchema = z.object({
  summary: z.string(),
  turn_count: z.number().int().nonnegative(),
  updated_at: z.iso.datetime({ offset: true }),
});
export type ConversationMemory = z.infer<typeof conversationSchema>;

function conversationKey(tgId: number | string): string {
  return `ward.conversation.${normalizeTgId(tgId)}`;
}

/** The rolling episodic summary — accumulates turn over turn, survives `/newsession`. */
export async function readConversation(tgId: number | string): Promise<ConversationMemory | null> {
  const raw = await backend().getState(conversationKey(tgId));
  if (raw === null || raw === undefined) return null;
  return conversationSchema.parse(raw);
}

export async function writeConversation(
  tgId: number | string,
  summary: string,
  turnCount: number,
): Promise<ConversationMemory> {
  const value = conversationSchema.parse({
    summary,
    turn_count: turnCount,
    updated_at: nowIso(),
  });
  await backend().setState(conversationKey(tgId), value);
  return value;
}
