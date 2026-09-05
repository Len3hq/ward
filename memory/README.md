# Sibyl Memory

The authorization substrate. Persisted in **Sibyl Memory** (the
`sibyl-memory-cli[mcp]` plugin — local-first SQLite, no vector DB), reached from
Ward's Bun process over the `sibyl-memory-mcp` stdio server.

This is the layer the eligibility gate tests: remove a user's authorization
entity from Sibyl Memory and the agent has no basis for authority, so it refuses
to act. Setup and the MCP wire contract are in
[`../SIBYL-MEMORY.md`](../SIBYL-MEMORY.md).

## Tier map

| Ward data                                                | Sibyl tier   | MCP tool (write / read)                 | Key                                        |
| -------------------------------------------------------- | ------------ | --------------------------------------- | ------------------------------------------ |
| authorization record (caps + inline ledgers)             | WARM entity  | `memory_remember` / `memory_recall`     | `ward.authorization` / `<ward_user_id>`    |
| wallet record                                            | WARM entity  | `memory_remember` / `memory_recall`     | `ward.wallet` / `<ward_user_id>`           |
| channel account → principal (Phase 9)                    | WARM entity  | `memory_remember` / `memory_recall`     | `ward.identity` / `<channel>:<account_id>` |
| principal → its channel accounts (Phase 9)               | WARM entity  | `memory_remember` / `memory_recall`     | `ward.accounts` / `<ward_user_id>`         |
| every mutation (onboard, spend, revoke, ACP job, wallet) | COLD journal | `memory_record_event`                   | category `ward.<kind>`                     |
| conversation summary (Phase 7)                           | HOT state    | `memory_set_state` / `memory_get_state` | `ward.conversation.<ward_user_id>`         |
| agent chat recall ("what did I buy?")                    | FTS5         | `memory_search`                         | —                                          |

The **WARM entity is the source of truth** for every gate decision — one point
read, always consistent. The **COLD journal** is the append-only narrative judges
look for ("dynamic-storage patterns top the band") and the audit trail
`memory_search` indexes. Both are load-bearing.

## Identity: what the entity name is

Every key above is a **`WardUserId`** (`ward_` + a 26-char ULID), not a channel's
own account id. A Telegram id, a Discord snowflake and an MCP token each resolve
to one through `ward.identity`; everything durable hangs off the principal alone,
so a user's caps, ledger and revocations are the same object whichever surface
they arrive from.

The principal is deliberately **non-numeric**. Telegram ids and Discord snowflakes
are both bare integers, so a numeric principal would let a Discord account silently
resolve onto a Telegram user's authorization record — `normalizeUserId` in
`store.ts` rejects anything that is not a `ward_<ulid>`, which makes that class of
bug unrepresentable rather than merely unlikely. Channel accounts are translated in
`src/identity/` and nowhere else. See [`../MULTI-CHANNEL.md`](../MULTI-CHANNEL.md).

## Code

| File                           | Role                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| `memory/schema.ts`             | zod schemas — the single validation point, run on every read and write    |
| `memory/store.ts`              | the read/write API (below); domain logic + per-user in-process write lock |
| `memory/trust.ts`              | `computeTrustScore` — the derived counterparty trust formula              |
| `memory/backend.ts`            | `MemoryBackend` interface + mode selection (`SIBYL_MEMORY_MODE`)          |
| `memory/backends/sibyl-mcp.ts` | the judged path — MCP stdio client to `sibyl-memory-mcp`                  |
| `memory/backends/fs.ts`        | hermetic JSON-file backend for tests / offline dev — **not judged**       |
| `memory/index.ts`              | public barrel                                                             |

`store.ts` owns all schema validation and domain logic; a backend only moves
opaque JSON documents. Swapping storage never touches `store.ts`.

## The authorization record

```jsonc
// entity  ward.authorization / <ward_user_id>
{
  "risk_label": "moderate", // "conservative" | "moderate" | "aggressive" — set once
  "standing_caps": { "per_action_limit_usd": 50, "daily_limit_usd": 100 },
  "spent_ledger": [
    // append-only; sum current-UTC-day rows for the daily cap
    {
      "ts": "2026-09-05T14:02:11.000Z",
      "amount_usd": 30,
      "action_type": "swap",
      "tx_hash": "0x…",
      "idempotency_key": "…",
    },
  ],
  "revocation_log": [
    // append-only; checked fresh before every action
    { "ts": "2026-09-05T16:00:00.000Z", "action_type": "swap", "reason": "user paused trading" },
  ],
  "acp_job_history": [
    // append-only; appended after every ACP job resolves
    {
      "ts": "2026-09-04T09:00:00.000Z",
      "counterparty_id": "agent://…",
      "job_type": "token_risk",
      "outcome_summary": "flagged rug indicators, correct",
      "trust_delta": 0.2,
    },
  ],
}
```

`action_type` ∈ `swap` | `x402_data_purchase` | `acp_job` — one enum for the spend
ledger and the revocation log.

**No `trust_score` is stored.** It is derived from `acp_job_history` on every read
(`trustScore()` / `computeTrustScore()`). Persisting it would let a hand-edited
entity lie about counterparty trust. Unknown keys are stripped on read, not
rejected.

## The wallet record

```jsonc
// entity  ward.wallet / <ward_user_id>
{
  "account_key": "ward_01J9…", // what the provider derives CDP account names from
  "smart_account": "0x…", // user's CDP Embedded Wallet smart account
  "agent_spender": "0x…", // agent's CDP Server Wallet
  "spend_permission": {
    // null until the user grants one on-chain
    "token": "USDC",
    "allowance_usd": 100,
    "period_seconds": 86400,
    "granted_tx": "0x…",
    "status": "active", // "revoked" after an on-chain revoke
  },
}
```

Replaced wholesale (`writeWallet`), not appended — `spend_permission.status` flips
as the on-chain grant changes.

**`account_key` is pinned, never rewritten.** The wallet provider derives its CDP
account names from it (`ward-user-<account_key>`), so the smart-account address is
a function of that string. New records use the `WardUserId`; records migrated by
`scripts/migrate-identity.ts` keep their _original Telegram id_, because rekeying
would point the user at a fresh, empty smart account and strand their funds and
their granted spend permission at the old address. This is why the field is stored
rather than derived from the principal.

## Read / write API (`memory/store.ts`)

| Function                                                                                 | Touches                                   | Behaviour                                                                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `read(userId)`                                                                           | reads the `ward.authorization` entity     | `UserAuthorization` or **`null`** when it is missing — the gate's trigger to refuse                     |
| `initialize(userId, { risk_label, per_action_limit_usd, daily_limit_usd })`              | writes the entity + `onboarded` event     | onboarding, once; throws if a record already exists                                                     |
| `appendSpend(userId, { amount_usd, action_type, tx_hash, idempotency_key, ts? })`        | updates the entity + `spend` event        | **idempotent on `idempotency_key`** (repeat key = no-op); throws if no record; `ts` defaults to now     |
| `spentToday(userId, now?)`                                                               | reads `spent_ledger`                      | sum of rows in the current UTC day; `0` for a missing record; pass `now` to test the boundary           |
| `appendRevocation(userId, { action_type, reason, ts? })`                                 | updates the entity + `revocation` event   | append-only                                                                                             |
| `isRevoked(userId, action_type)`                                                         | reads `revocation_log`                    | **fresh read every call** — a mid-session revoke takes effect immediately; `false` for a missing record |
| `appendAcpJob(userId, { counterparty_id, job_type, outcome_summary, trust_delta, ts? })` | updates the entity + `acp_job` event      | append-only; `trust_delta` ∈ [-1, 1]                                                                    |
| `trustScore(userId, counterpartyId)`                                                     | reads `acp_job_history`                   | derived, never stored; neutral `0.5` with no history for that counterparty                              |
| `readWallet(userId)`                                                                     | reads the `ward.wallet` entity            | `WalletRecord` or `null`                                                                                |
| `writeWallet(userId, record)`                                                            | writes the entity + `wallet_update` event | full replace, validated                                                                                 |

Ledgers are never mutated or reordered — only appended. Writes for one user are
serialised by an in-process lock, so concurrent Telegram turns cannot drop a row.

## Derived trust (`memory/trust.ts`)

Recency-weighted exponential moving average over per-job "goodness":

```
goodness_i = clamp01(0.5 + trust_delta_i / 2)          // -1 → 0.0, 0 → 0.5, +1 → 1.0
score_0    = 0.5                                        // NEUTRAL_PRIOR — unproven counterparty
score_i    = 0.4 * goodness_i + 0.6 * score_{i-1}       // ALPHA = 0.4, oldest → newest
```

Bounded [0, 1], starts neutral, monotonic in `trust_delta`, most recent jobs
dominate. Read before choosing a counterparty (Phase 6).

## Tests

- `test/memory.store.test.ts` — every function against the `fs` backend, including
  the `spentToday` day boundary and the double-`appendSpend` idempotency case.
- `test/memory.trust.test.ts` — the trust formula.
- `test/memory.sibyl-mcp.test.ts` — the live Sibyl Memory MCP path; opt-in
  (`sibyl-memory-mcp` on PATH **and** `SIBYL_MEMORY_MCP_TEST=1`), skipped otherwise.
- `test/identity.test.ts` — the principal, the channel-account index, and the
  migration round-trip (which runs `scripts/migrate-identity.ts` as a subprocess
  against a temp `fs` store).

Run with `bun test`.
