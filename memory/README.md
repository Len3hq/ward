# Sibyl Memory

The authorization substrate. Persisted in **Sibyl Memory** (the
`sibyl-memory-cli[mcp]` plugin — local-first SQLite, no vector DB), reached from
Ward's Bun process over the `sibyl-memory-mcp` stdio server.

This is the layer the eligibility gate tests: remove a user's authorization
entity from Sibyl Memory and the agent has no basis for authority, so it refuses
to act. Setup and the MCP wire contract are in
[`../SIBYL-MEMORY.md`](../SIBYL-MEMORY.md).

## Tier map

| Ward data                                                | Sibyl tier   | MCP tool (write / read)                 | Key                                    |
| -------------------------------------------------------- | ------------ | --------------------------------------- | -------------------------------------- |
| authorization record (caps + inline ledgers)             | WARM entity  | `memory_remember` / `memory_recall`     | `ward.authorization` / `<telegram_id>` |
| wallet record                                            | WARM entity  | `memory_remember` / `memory_recall`     | `ward.wallet` / `<telegram_id>`        |
| every mutation (onboard, spend, revoke, ACP job, wallet) | COLD journal | `memory_record_event`                   | category `ward.<kind>`                 |
| conversation summary (Phase 7)                           | HOT state    | `memory_set_state` / `memory_get_state` | `ward.conversation.<telegram_id>`      |
| agent chat recall ("what did I buy?")                    | FTS5         | `memory_search`                         | —                                      |

The **WARM entity is the source of truth** for every gate decision — one point
read, always consistent. The **COLD journal** is the append-only narrative judges
look for ("dynamic-storage patterns top the band") and the audit trail
`memory_search` indexes. Both are load-bearing.

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
// entity  ward.authorization / <telegram_id>
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
// entity  ward.wallet / <telegram_id>
{
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

## Read / write API (`memory/store.ts`)

| Function                                                                               | Touches                                   | Behaviour                                                                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `read(tgId)`                                                                           | reads the `ward.authorization` entity     | `UserAuthorization` or **`null`** when it is missing — the gate's trigger to refuse                     |
| `initialize(tgId, { risk_label, per_action_limit_usd, daily_limit_usd })`              | writes the entity + `onboarded` event     | onboarding, once; throws if a record already exists                                                     |
| `appendSpend(tgId, { amount_usd, action_type, tx_hash, idempotency_key, ts? })`        | updates the entity + `spend` event        | **idempotent on `idempotency_key`** (repeat key = no-op); throws if no record; `ts` defaults to now     |
| `spentToday(tgId, now?)`                                                               | reads `spent_ledger`                      | sum of rows in the current UTC day; `0` for a missing record; pass `now` to test the boundary           |
| `appendRevocation(tgId, { action_type, reason, ts? })`                                 | updates the entity + `revocation` event   | append-only                                                                                             |
| `isRevoked(tgId, action_type)`                                                         | reads `revocation_log`                    | **fresh read every call** — a mid-session revoke takes effect immediately; `false` for a missing record |
| `appendAcpJob(tgId, { counterparty_id, job_type, outcome_summary, trust_delta, ts? })` | updates the entity + `acp_job` event      | append-only; `trust_delta` ∈ [-1, 1]                                                                    |
| `trustScore(tgId, counterpartyId)`                                                     | reads `acp_job_history`                   | derived, never stored; neutral `0.5` with no history for that counterparty                              |
| `readWallet(tgId)`                                                                     | reads the `ward.wallet` entity            | `WalletRecord` or `null`                                                                                |
| `writeWallet(tgId, record)`                                                            | writes the entity + `wallet_update` event | full replace, validated                                                                                 |

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

Run with `bun test`.
