# Ward — Build Phases & Len3 Infrastructure Map

**Purpose.** A build plan for *Ward* — a personal crypto agent whose file-based memory is the authorization substrate for money movement on Base. Written against two sources:
- `Build-Plan-Sibyl-Hackathon.md` — the council-reviewed product plan (what to build, why it scores).
- `Len3-System-Overview.md` — the code-verified map of the Len3 production system (what we can reuse).

This document decides, component by component, **what infrastructure to pull from Len3, what to adapt, what to rebuild, and what to leave behind**, then sequences it into dependency-ordered phases.

**Guiding decision (from the council):** a *new* public repo, file-based memory as the first commit, then **deliberately vendor a small, named set of files from Len3 with attribution**. This is not "copy Len3 and delete the infra." The vendor list is intentionally short. Most of Len3 is out of scope.

---

## 1. The inversion — Len3 vs. Ward

Len3 and Ward share a shape (personal crypto agent, chat surface, pays for premium data via x402, accumulating user profile) but sit on **opposite infrastructure**:

| Axis | Len3 (production) | Ward | Consequence |
|---|---|---|---|
| Chain | Solana-first (EVM read-only via Alchemy) | **Base** (execution is a scored partner stack, ×1.15) | x402 payment rail and wallet layer are **rebuilt for EVM/Base**, not ported |
| Memory / state | PostgreSQL 16 + pgvector, LangGraph `PostgresSaver` checkpoints | **Sibyl Memory** — the `sibyl-memory-cli[mcp]` plugin (local-first SQLite + FTS5, five-tier schema, no vector DB), reached over the `sibyl-memory-mcp` stdio server (hard eligibility gate) | The persistence layer is net-new: an MCP-client adapter to Sibyl Memory; the checkpointer is swapped for `MemorySaver` |
| Retrieval | pgvector hybrid search (RRF + temporal boost) over a DB catalog | Static file catalog + keyword match | x402 discovery is **downgraded on purpose** — simpler, and vector DBs are disqualifying |
| Wallet / custody | Privy server wallets + platform relay wallet (gas abstraction) | **Coinbase CDP Embedded Wallet (MPC) for the user + a CDP Server Wallet as the agent spender + on-chain Spend Permission** | Non-custodial, scoped, revocable — the PayBox model, Base-native. Privy and the relay are dropped. |
| Process topology | Two services: Bun agent + FastAPI backend + Celery + Redis | **One Bun process** + the `sibyl-memory-mcp` child process. No backend, no Celery, no Redis | Memory I/O is an MCP call to Sibyl Memory; the agent does gateway + graph + memory I/O + execution in-process |
| Counterparty market | none | **Virtuals ACP** job (×1.25 combined cap) | Net-new; Len3 has nothing here |

**Runtime decision:** single **Bun + TypeScript** process, matching the vendored agent code. Durable state lives in **Sibyl Memory** — the official `sibyl-memory-cli[mcp]` plugin (SQLite under `~/.sibyl-memory/`, activated with `sibyl init`). Ward's process is an MCP client of the `sibyl-memory-mcp` stdio server; `memory/backends/sibyl-mcp.ts` is the adapter. A `MemoryBackend` interface keeps a hermetic JSON-file backend (`SIBYL_MEMORY_MODE=fs`) for tests and offline dev — **not the judged path**. No database of our own; no vector store.

---

## 2. Component inventory — Len3 → verdict

`VENDOR` = copy with attribution, minimal edits · `ADAPT` = reuse the logic/structure, swap the substrate · `REBUILD` = new code, Len3 informs the design · `DROP` = out of scope.

### Reuse (the whole vendor list)

| Len3 source | Verdict | What we take | Adaptation |
|---|---|---|---|
| `agent/src/graph/` (index.ts, state.ts, nodes/) | **VENDOR** | StateGraph wiring; `guard → router → (onboarding\|summarizer\|agent) → approval → tools` topology; `MessagesAnnotation` + per-turn state fields | Replace `PostgresSaver` with `MemorySaver`; durable state comes from the Sibyl Memory layer (§7). Trim state fields to what we use. |
| `agent/src/graph/nodes/approval.ts` | **VENDOR (verbatim)** | The HITL payment gate: `interrupt({ type, cost, endpoint })`, gateway resumes with `Command({ resume:{ approved }})` | Keep as-is; the copy shown to the user cites the memory-derived cap remaining and the on-chain allowance remaining. Judge-facing evidence the agent checks its authorization before spending. |
| `agent/src/gateways/telegram.ts` | **VENDOR + trim** | Telegraf long-polling, streaming message edits, markdown→HTML, 4096-char split, interrupt detection, `/newsession` / `/defaultsession` | Strip `PlatformLink` / `resolve-user` / JWT minting. User resolution = Telegram user id → Sibyl Memory `ward.authorization` + `ward.wallet` entities. `/newsession` stays — the cleanest "fresh session" recall trigger. |
| `agent/src/security/guardrails.ts` | **VENDOR** | Explicit-injection regexes (hard block), suspicious-pattern detection, crypto keyword fast-path, `sanitizeUrls` trusted-domain allowlist, `<user_input>` wrapping | The one explicit validation step between external data and the execution trigger. ACP counterparty output and price-feed data pass through it before reaching the LLM or executor. |
| `agent/src/routing/intentTables.ts` | **ADAPT (heavy trim)** | The deterministic pre-LLM intent-routing pattern | Collapse to: `connect_wallet`, `grant_permission`, `revoke`, `swap`, `x402_data_purchase`, `acp_job`, `read_only`. One table. |
| `backend/src/services/x402_service.py` — `estimate_cost` / `requires_approval` | **ADAPT → TS** | The approval-gate decision function: approve-needed if `total > effective_auto_limit`, per-request limit exceeded, daily limit exceeded, first-time endpoint, or session budget exceeded | Port to one TS module. Point it at the Sibyl Memory `UserAuthorization` record (via `memory/store.ts`) + the on-chain Spend Permission, not `SpendingControls` + summed `AgentWalletTransaction` rows. |
| `backend/src/services/x402_client.py` + `catalog_provider.py` | **ADAPT** | The orchestration: request → `402` → parse `PaymentRequirements` → pay → retry with proof header → extract receipt → update trust signals; the env-driven catalog concept | Replace the Solana/Privy transfer with the **official Base x402 client** (`x402-fetch` / `x402-axios`, EIP-3009 `transferWithAuthorization`, Coinbase facilitator settling on Base), funded from the agent's CDP Server Wallet. Replace pgvector catalog search with a static `x402-catalog.json` + substring match. Keep the trust-score update (§7). |
| x402 trust scoring (`x402_service` trust_tier / trust_score: tier base + success ratio × 30 + bonuses) | **ADAPT** | The formula | Reuse for both x402 endpoints and ACP counterparties; store the counters in memory, derive `trust_score` on read. |
| `backend/src/services/privy/*` (server-wallet create, sign, transfer) | **ADAPT → Coinbase CDP** | The *pattern* only — a provider-managed MPC wallet the agent controls, plus a facilitator/relayed-payment flow | Same shape, different provider: **Coinbase CDP Server Wallet** for the agent spender; the user side is a **CDP Embedded Wallet**. See §4. |
| `agent/src/config.ts` | **VENDOR** | Env-config loader + `MODELS` map + brand constants pattern | Trim to the models we use — **agent + guard both `gpt-4o-mini`** (OpenAI). Also carries `CDP_PROXY_URL` (§4 geoblock note). |
| `agent/src/prompts/` | **ADAPT** | System-prompt structure (persona + profile + context + intent hint), onboarding question pattern | Rewrite content for Ward. Onboarding asks `risk_label` + `per_action_limit_usd` + `daily_limit_usd` once. |
| `agent/src/memory/session_summary.ts` | **VENDOR (optional — Phase 7)** | Per-user buffer → idle-triggered LLM summary → append to durable memory | Write the summary to Sibyl Memory's **HOT state** tier (`memory_set_state`, key `ward.conversation.<id>`) instead of a vector doc. Strengthens the "memory accumulates" story for the 40-pt line. |
| `agent/src/evals/` | **ADAPT** | The behavioural eval-harness pattern | Becomes the judge-facing deletion-gate test harness (§8). |

### Design references (inform new code, nothing copied)

| Len3 source | Informs |
|---|---|
| `SpendingControls` model + `spending_controls_service.py` (`check_request_limit`, `check_daily_limit`, `block_source`) | The `standing_caps` + `spent_ledger` + `revocation_log` schema and enforcement loop in §7 |
| `AgentWalletTransaction` (`transaction_type`, `external_id` idempotency, `balance_before/after`) | The `spent_ledger` entry shape and idempotency approach |
| `graph/nodes/router.ts` (profile fetch → onboarding vs. agent decision) | The router's "memory missing → refuse / caps unset → onboard / else → agent" branch that makes the deletion gate structural |
| `X402Service.request_premium_data` reserve→check→refresh→deduct sequence | The order of operations in the execution path (Phase 5) |
| `helius_webhook_service` real-time deposit reconciliation | Optional: reconcile the agent spender's on-chain balance if it drifts from expectations |
| `financial_ledger_service.py` append-only ledger discipline | Never mutate `spent_ledger` entries; append only |
| `proactive/webhook.ts` "send directly, never run the graph" | If we add any proactive nudge, keep it off the graph path |

### Dropped (explicitly not vendored)

Portfolio sync pipeline (Jupiter/Alchemy fetchers, `wallet_portfolio_fetcher`, transaction indexing, protocol parsers) · P&L / risk / pattern services (FIFO tax lots, `RealizedPnLEvent`, snapshots) · the insight pipeline (signal workers, `market.match_signals_to_all_users`, `ContextAssembler`, `InsightGenerator`, delivery gates) · news aggregation · CEX connectors · NFT fetchers · RAG / pgvector / `retrieval_pipeline_service` / embeddings · Celery + RedBeat + all beat tasks · Redis · WebSocket layer · **Privy** · relay wallet + gas abstraction · faucet + treasury sweep + billing (`BillingService`, `service_catalog`, margin earmarks) · the FastAPI app, auth (JWT/OTP/sessions), `PlatformLink` linking flow · Discord + WhatsApp gateways (Telegram only) · web + web-admin dashboards · the ~55 SQLAlchemy models · all ~40 route modules and ~50 migrations.

---

## 3. Target architecture

```
                 Telegram (Telegraf, long-polling)
                        │  /newsession = fresh-session recall trigger
                        ▼
┌──────────────────────────────────────────────────────────────────┐
│  Ward agent — single Bun process                                  │
│                                                                  │
│  graph:  guard ─► router ─► (onboarding | agent)                 │
│                              agent ⇄ tools                        │
│                              agent ─► approval ─► tools           │
│                                                                  │
│  tools:  read_authorization   connect_wallet   grant_permission   │
│          revoke               swap_on_base     pay_x402_endpoint  │
│          discover_x402        get_token_price  post_acp_job       │
│                                                                  │
│  memory/   ── domain API + backend adapter ─────────────┐        │
│    schema.ts / store.ts / trust.ts                       │        │
│    backend.ts → backends/sibyl-mcp.ts | backends/fs.ts   │        │
│    catalog/x402-catalog.json          (static, Phase 5)  │        │
│                                                          │        │
│  wallet/                                                  │       │
│    user-wallet.ts     Coinbase CDP Embedded Wallet (MPC) │       │
│    agent-spender.ts   Coinbase CDP Server Wallet (MPC)   │       │
│    spend-permission.ts  grant / read / revoke on Base    │       │
│  execution/                                               │       │
│    gate.ts            ported requires_approval logic     │       │
│    swap.ts            capped swap, Base DEX               │       │
│    x402-base.ts       x402-fetch + trust write-back      │       │
│    acp.ts             Virtuals ACP job + trust write-back│       │
└───────────────┬──────────────────────────────────────────┼───────┘
                │ stdio (MCP)                               │
   Sibyl Memory ◄── sibyl-memory-mcp: WARM entities (authorization, wallet),
                    COLD journal (every mutation), HOT state (conversation)
                    ~/.sibyl-memory/memory.db  ·  `sibyl init` to activate
                                                           │
   Base  ◄── Spend Permission grant/revoke, swap tx, x402 settlement, ACP escrow
   x402 endpoints (premium data)  ◄── HTTP 402 → pay → retry
   Virtuals ACP  ◄── job post / escrow / result
   Coinbase CDP API  ◄── MPC key ops for both wallets
```

**Every execution tool call runs the same gate, in this order** (ported from Len3's x402 flow, generalised to all action types):

1. `read(tgId)` → if the Sibyl Memory `ward.authorization` entity is missing → **refuse, explain why.** *(This is the literal judges' test.)*
2. Sum today's `spent_ledger` (current UTC day) vs. `daily_limit_usd`. Over → refuse or scale down.
3. Check `revocation_log` for this `action_type` — read **fresh**, not cached from session start.
4. Amount vs. `per_action_limit_usd`.
5. Read the on-chain **Spend Permission**: still active? allowance remaining this period?
6. Executable amount = `min(memory cap remaining, on-chain allowance remaining)`. If zero → refuse.
7. If any gate says "needs approval" → `approval` node `interrupt()` with the cost and both remaining limits.
8. Execute on Base (agent spender pulls funds within the Spend Permission).
9. **Append** to `spent_ledger` via `appendSpend` (idempotent on a client key) — updates the WARM entity and appends a COLD journal event. For ACP, also `appendAcpJob` and let `trustScore` re-derive.

**The two-limit design is the point:** the on-chain Spend Permission is the hard outer bound the user controls directly; Sibyl Memory is the agent's own policy layer (per-action limit, action-type revocation, accumulating ledger, counterparty trust) that can only be *stricter*. Delete the Sibyl Memory authorization entity and the agent has no policy — it refuses, even though the chain would still allow a spend.

---

## 4. Wallet & authorization model (the PayBox model, Base-native)

**Three keys, no seed phrases, non-custodial:**

| Party | Wallet | Provider | Role |
|---|---|---|---|
| User | **CDP Embedded Wallet** (MPC/TEE, email or passkey login) → smart account | Coinbase CDP | Holds the user's funds. User signs in from a link; key shares are split, user retains control. |
| Agent | **CDP Server Wallet** (MPC) | Coinbase CDP | The *spender*. Pulls funds from the user's smart account only up to the granted Spend Permission. Funds x402 payments and swap inputs. |
| — | **Spend Permission** on Base | Coinbase Smart Wallet / Spend Permission Manager contract | On-chain grant: `{ token: USDC, allowance: <daily_limit>, period: 1 day, spender: <agent server wallet> }`. Revocable on-chain by the user at any time. |

**Grant/revoke is an on-chain contract interaction** — a third qualifying Base action alongside x402 payment and the swap, and the cleanest possible "revocable" demo (revoke on camera → agent immediately can't spend).

**Onboarding flow:**
1. User messages the bot → gets a one-tap link → signs into a CDP Embedded Wallet (email/passkey). The `ward.wallet` entity records the smart-account address.
2. Agent asks the three authorization questions (risk label, per-action limit, daily limit) → `initialize()` writes the `ward.authorization` entity.
3. User approves a Spend Permission scoped to `daily_limit_usd` in USDC on Base. The `ward.wallet` entity records the permission reference.
4. From here the agent acts within `min(on-chain allowance, memory caps)`, logging every spend to `spent_ledger`.

**Fallback:** if wallet-connect isn't solid, a single agent-owned CDP Server Wallet funded with testnet USDC still demonstrates the full memory loop — the caps just aren't mirrored on-chain. Keep this path working as a hedge; don't ship it as the story.

---

## 5. Build phases

Dependency-ordered. Phases 1 and the ACP spike (Phase 6) should start together — everything else depends on knowing the memory schema and whether ACP settles.

### Phase 0 — Repo & skeleton

- New public GitHub repo, `LICENSE` (MIT), `README.md` stub, `ATTRIBUTION.md` stub.
- Bun + TypeScript. Deps: `@langchain/langgraph`, `@langchain/core`, `@langchain/openai` (agent LLM = **`gpt-4o-mini`**), `telegraf`, `zod`, `viem`, `@coinbase/cdp-sdk`, `x402-fetch` (+ `x402` core), `@modelcontextprotocol/sdk` (Sibyl Memory MCP client), `dotenv`.
- **Sibyl Memory account:** `pip install 'sibyl-memory-cli[mcp]'` (Python 3.10+), `sibyl init` (browser activation), `sibyl status` (confirm Pro tier + DB path). Documented in `SIBYL-MEMORY.md`.
- `.env.example` (no secrets); `.gitignore` covers `.env`, the `fs` backend's local data (`memory/users/`, `memory/state/`, `memory/journal.ndjson`), any key material.
- **First real commit = the memory module (Phase 1)**, so the history shows memory came first.
- CI: lint + typecheck + `bun test` (memory suite runs on the `fs` backend — no Sibyl install needed in CI); the deletion-gate test is added in Phase 7.

**Exit:** `bun run dev` starts, connects to Telegram, replies to any message.

**Status: done.** TS pinned to 5.9 (typescript-eslint compat); dep versions bumped to current majors.

---

### Phase 1 — Sibyl Memory module

The accumulating store on **Sibyl Memory**, with the full read/write API the agent and the gate depend on. Built before anything consumes it.

**Len3 inputs:** `SpendingControls` + `spending_controls_service.py` (enforcement shape), `AgentWalletTransaction` (ledger entry shape, idempotency), `financial_ledger_service.py` (append-only discipline).

**Tier map** (Sibyl Memory's five tiers → Ward data):

| Ward data | Sibyl tier | MCP tool | Key |
|---|---|---|---|
| authorization record (caps + inline ledgers) | WARM entity | `memory_remember` / `memory_recall` | `ward.authorization` / `<tg_id>` |
| wallet record | WARM entity | `memory_remember` / `memory_recall` | `ward.wallet` / `<tg_id>` |
| every mutation | COLD journal | `memory_record_event` | category `ward.<kind>` |
| conversation summary (Phase 7) | HOT state | `memory_set_state` / `memory_get_state` | `ward.conversation.<tg_id>` |
| agent chat recall | FTS5 | `memory_search` | — |

The WARM entity is the source of truth for every gate decision; the COLD journal is the append-only narrative ("dynamic-storage patterns top the band").

**Build (`memory/`):**
- `schema.ts` — `UserAuthorization` (§7) + `WalletRecord` + `JournalEvent`, zod-validated on every read and write.
- `backend.ts` — `MemoryBackend` interface + mode select (`SIBYL_MEMORY_MODE`: `sibyl-mcp` default, `fs` for tests/offline).
- `backends/sibyl-mcp.ts` — MCP stdio client to `sibyl-memory-mcp`; maps the domain API onto the `memory_*` tools. **The judged path.**
- `backends/fs.ts` — hermetic JSON-file backend. Not judged; keeps `bun test` and offline dev working without Python 3.10+.
- `store.ts` (unchanged public API — owns all schema checks + domain logic + per-user write lock):
  - `read(tgId): UserAuthorization | null` — `null` when the entity doesn't exist (the gate's trigger).
  - `initialize(tgId, { risk_label, per_action_limit_usd, daily_limit_usd })` — onboarding writes once.
  - `appendSpend(tgId, entry)` — append-only, idempotent on `entry.idempotency_key`; updates entity + appends journal event.
  - `appendRevocation(tgId, entry)` / `isRevoked(tgId, action_type)` — fresh read every call.
  - `appendAcpJob(tgId, entry)` / `trustScore(tgId, counterpartyId)` — derived, never stored.
  - `spentToday(tgId, now?): number` — sum `spent_ledger` for the current UTC day.
  - `readWallet(tgId)` / `writeWallet(tgId, record)` — smart-account address, spend-permission ref.
- `trust.ts` — `computeTrustScore` (recency-weighted EMA).
- `memory/README.md` — the tier map, record format, which function reads/writes which field. `SIBYL-MEMORY.md` — setup + the MCP wire-contract verification step.

**Exit:** unit tests for every function (`fs` backend); `spentToday` correct across a day boundary; a double `appendSpend` with the same key writes one entry. Opt-in `memory.sibyl-mcp.test.ts` exercises the live MCP path.

**Status: done.** Both backends working. The MCP wire contract is **verified against a live `sibyl-memory-mcp` 0.2.0** (installed via pipx on Python 3.13; runs unactivated) — `tools/list` + real calls; `SIBYL_MEMORY_MCP_TEST=1 bun test` passes (onboard/read, ledger survives reconnect, idempotency, deletion gate). Corrections applied: `memory_remember`/`memory_set_state` take `body` not `value`; `memory_record_event` takes `{kind, body}`; recall unwraps `entity.body`, get_state unwraps `body` / `{ok:false}`. `sibyl init` (Pro tier activation) still pending — not needed for dev/test.

---

### Phase 2 — Agent core (graph)

The LangGraph scaffold running on Sibyl Memory (via `memory/store.ts`).

**Len3 inputs (VENDOR):** `agent/src/graph/`, `graph/nodes/approval.ts`, `config.ts`, `prompts/`.

**Build / adapt:**
- Copy the graph wiring. Checkpointer = `MemorySaver` (turn state is ephemeral; durable state is Sibyl Memory).
- `guard` node — from `guardrails.ts` (full detection wired in Phase 3).
- `router` node — adapt: `read(tgId) === null` **and** an action request → terminal `refuse` node explaining the missing authorization; record exists but `risk_label` unset → `onboarding`; else → `agent`.
- `onboarding` node — canned-question pattern: risk label, per-action limit, daily limit (one per turn), then `store.initialize`, then prompt the wallet connect + Spend Permission (Phase 4).
- `agent` node — vendor the system-prompt assembly; context block = the user's `UserAuthorization` summary (caps, spent today, active revocations, known counterparties + trust, wallet status). Bind tools.
- `approval` node — vendor verbatim.
- `tools` node — `ToolNode`.

**Exit:** in a fresh Telegram chat the agent onboards a user, writes the `ward.authorization` entity to Sibyl Memory, and after `/newsession` still recalls the caps from it.

**Status: done.** `src/agent/` — `state.ts`, `graph.ts` (`guard → router → (onboarding | agent | refuse)`, `agent ⇄ tools`, `agent → approval → tools`; `MemorySaver`), `prompts.ts` (persona + onboarding Qs + answer parsing + the authorization context block), `guardrails.ts` (explicit-injection hard block only — rest is Phase 3), `tools.ts` (one read-only `read_authorization` tool, `tgId` bound per-call not model-visible), nodes for guard / router / onboarding / agent / refuse / approval. `src/telegram/gateway.ts` — minimal message→graph→reply bridge with `/newsession` (Phase 3 vendors the full gateway on top). Agent LLM = **`gpt-4o-mini`** (`@langchain/openai`); agent node falls back to deterministic memory recall without `OPENAI_API_KEY`. `src/net.ts` — `installCdpProxy()` routes only `*.coinbase.com` through `CDP_PROXY_URL` (geoblock workaround, no-op when unset). `test/agent.graph.test.ts` — onboarding, fresh-session recall, deletion gate → refuse, injection block. 35 pass / 4 skip. Live LLM path not yet exercised (no key on the dev box).

---

### Phase 3 — Telegram gateway, intent parsing, guardrails

The trigger surface and the input-validation boundary.

**Len3 inputs (VENDOR + trim):** `gateways/telegram.ts`, `security/guardrails.ts`, `routing/intentTables.ts`.

**Build / adapt:**
- Telegram gateway: keep streaming edits, markdown→HTML, char-split, interrupt detection (approval yes/no → `Command({ resume })`), `/newsession` / `/defaultsession`. Remove linking/JWT code; user = Telegram id.
- Intent parsing: one LLM tool-call step — free text → `{ action_type, amount_usd, pair?, token?, endpoint? }`.
- `intentTables.ts` trimmed to the Ward action set, routing to the right tool and pre-empting an LLM round-trip on obvious cases.
- Guardrails fully wired: injection hard-block, suspicious-pattern flag, `sanitizeUrls` on every reply, and a `validateExternalData()` pass on any price-feed / x402 / ACP payload before it reaches the executor or the LLM.
- Confirmation reply before execution: *"Swap $50 USDC → ETH. $30 of your $100 daily cap used, $70 left; on-chain allowance $70 remaining. Confirm?"* — plain yes/no.

**Exit:** "swap $50 usdc for eth" produces a structured action + a confirmation prompt citing the real limits; an injection string in a fake x402 response is stripped before the agent sees it.

**Status: done.**
- `src/agent/intent.ts` — deterministic `tableIntent` (Ward action set: connect_wallet / grant_permission / revoke / swap / x402_data_purchase / acp_job / read_only) + `parseIntent` (table → one `gpt-4o-mini` structured call → `read_only` fallback). `SPEND_ACTIONS` = {swap, x402_data_purchase, acp_job}.
- `src/agent/guardrails.ts` — full: injection hard-block, `detectSuspicious` (flag), crypto fast-path, `sanitizeUrls` (trusted-host allowlist + per-call extras), `wrapUserInput` (`<user_input>`), `validateExternalData` (strip control chars, neutralise injection, cap length, wrap in `<untrusted_data>`).
- Graph: `guard → intent → router → (onboarding | agent | refuse | confirm)`. `confirm` node cites the real memory limits, blocks over-cap / revoked before the interrupt, then `interrupt({ type: "confirm_action", … })`. `agent` node wraps human turns, injects an intent hint + suspicious flag, `sanitizeUrls` on output. (On-chain allowance line lands in Phase 4/5.)
- `src/telegram/gateway.ts` — vendored gateway: `graph.stream(streamMode: ["messages","values"])` with throttled edits, `mdToHtml`, `splitMessage` (4096), interrupt detection → yes/no → `Command({ resume })`, `/newsession` + `/defaultsession`.
- Tests: `agent.intent.test.ts`, `agent.guardrails.test.ts`, `telegram.gateway.test.ts`, + confirmation flow in `agent.graph.test.ts`. 62 pass / 4 skip.
- **State channel gotcha:** a LangGraph channel can't share a name with a node — the intent channel is `parsedIntent`, the onboarding-draft channel is `onboardingDraft`.

---

### Phase 4 — Wallet & authorization layer (Coinbase CDP + Spend Permissions)

**Len3 inputs (ADAPT → Coinbase):** `services/privy/*` (the managed-MPC-wallet + relayed-payment *pattern*).

**Geoblock note:** Coinbase's API (`api.cdp.coinbase.com`, the x402 facilitator) geoblocks some regions. `src/net.ts::installCdpProxy()` (already wired into the entrypoint) patches `globalThis.fetch` so only `*.coinbase.com` requests route through `CDP_PROXY_URL` — set it for local dev in a blocked region, leave it unset on Railway. The `@coinbase/cdp-sdk` `CdpClient` has no `fetch` option, so the global patch is the injection point; it must run before the first CDP call (it does — at boot).

**Build (`wallet/`):**
- `user-wallet.ts` — CDP Embedded Wallet: generate the sign-in link, resolve the callback, create/fetch the user's smart account, persist the address via `writeWallet` (the `ward.wallet` entity).
- `agent-spender.ts` — one CDP Server Wallet (MPC) as the agent's spender identity; funds x402 and swap inputs; balance read/reconcile helper.
- `spend-permission.ts` — build the Spend Permission `{ token: USDC, allowance, period, spender }`, produce the user-approval step, read current allowance/used from chain, and a `revoke()` that submits the on-chain revocation.
- Wire `grant_permission` / `revoke` / `connect_wallet` as agent tools; `revoke` also writes a `revocation_log` entry so memory and chain agree.

**Exit:** a user connects a wallet, grants a $100/day USDC Spend Permission on Base, and the agent can read "allowance remaining" from chain; revoking on-chain makes the next spend attempt refuse.

**Status: done** (against the stub provider; the real CDP path is code-complete, live-unverified).
- `src/wallet/provider.ts` — `WalletProvider` interface + selector (`cdp` when all three `CDP_*` keys are set, else `stub`). Pure infra, never touches Sibyl Memory.
- `src/wallet/cdp.ts` — `CdpWalletProvider`: named CDP accounts (`ward-agent-spender`, `ward-user-<tgId>` owned by `ward-owner-<tgId>` with `enableSpendPermissions`), `createSpendPermission` (token `usdc`, `periodInDays`), `listSpendPermissions` (status + allowance), `revokeSpendPermission`, `waitForUserOperation` to settle. CDP field names taken from SDK 1.55 types — **verify live** with `WARD_CDP_TEST=1 bun test test/wallet.cdp.test.ts`.
- `src/wallet/stub.ts` — deterministic fake addresses + in-memory permission state; the tested path.
- `src/agent/nodes/wallet.ts` — deterministic node (no LLM). `connect_wallet` writes `ward.wallet`; `grant_permission` grants (allowance = `amount_usd ?? daily_limit_usd`, 1-day period) + updates `ward.wallet`; `revoke` with scope "permission" → on-chain revoke + `appendRevocation` for every action type, scope = one action → memory-only `appendRevocation`. Router routes `{connect_wallet, grant_permission, revoke}` → `wallet`.
- `src/agent/nodes/confirm.ts` — now reads `ward.wallet` + the live provider: refuses on a revoked permission, computes `executable = min(memory remaining, allowance − spentToday)`, and the confirmation cites "on-chain allowance $X remaining".
- `src/net.ts` proxy already wired (Phase 2).
- Custody framing: managed-MPC via CDP + revocable on-chain Spend Permission. The real Embedded-Wallet (user holds key shares) needs a browser sign-in page — out of scope for the bot; noted in `WALLET.md`.
- Tests: `wallet.stub.test.ts`, `wallet.cdp.test.ts` (opt-in), + wallet/permission flow in `agent.graph.test.ts`. 71 pass / 7 skip.

---

### Phase 5 — Base execution engine (x402 + swap)

Two independent, judge-recognised Base actions sharing one memory-enforced ledger.

**Len3 inputs (ADAPT):** `x402_service.py::estimate_cost/requires_approval` (gate → TS), `x402_client.py` (orchestration order), `catalog_provider.py` (env-driven catalog concept), trust-score formula.

**Build (`execution/`):**
- `gate.ts` — the ported `requires_approval` function. Inputs: `UserAuthorization`, on-chain allowance, `action_type`, `amount_usd`, `endpoint?`. Output: `{ allow, needs_approval, executable_amount, reason }`.
- `x402-base.ts`:
  - Discovery: load `catalog/x402-catalog.json` (name, description, url, method, cost, tags), substring/keyword match. (Replaces pgvector hybrid search.)
  - Payment: wrap the agent spender with `x402-fetch`. Request → `402` → EIP-3009 `transferWithAuthorization` → retry with the payment header → data + receipt. Facilitator settles on Base.
  - After: `appendSpend({ action_type: "x402_data_purchase", amount_usd, tx_hash, idempotency_key })`; update per-endpoint success/failure counters feeding `trust_score`.
- `swap.ts`:
  - Capped swap on Base via a deployed DEX router (Uniswap v3 `SwapRouter02` on Base, or Aerodrome). **Risk:** testnet DEX liquidity is thin — fallback is a WETH wrap/unwrap presented honestly as the swap primitive, or a self-deployed constant-product pool with test tokens. Decide early.
  - Same gate → same `approval` interrupt → same `appendSpend({ action_type: "swap", ... })`.
- Every execution reply includes the tx hash / explorer link.

**Exit:** both actions run end-to-end on Base; both write to the same `spent_ledger`; "how much has the agent spent today" is one number across both; hitting either the memory daily cap or the on-chain allowance blocks the next action of either type.

**Status: done** (against the stub provider; the real CDP/x402 path is code-complete, live-unverified).
- `src/execution/gate.ts` — `evaluateGate({ record, actionType, amountUsd, spentTodayUsd, revoked, onchainAllowanceUsd, endpointSeen? })` → `{ allow, needsApproval, executableUsd, reason }`. `needsApproval` = amount > `WARD_AUTO_APPROVE_USD` (default 0) OR first-time endpoint OR conservative risk label. Pure; re-run on fresh reads by the `execute` node.
- `src/execution/catalog.ts` — loads `memory/catalog/x402-catalog.json`, keyword/tag `searchCatalog`. `src/execution/explorer.ts` — basescan tx links.
- Schema: `x402_ledger: [{ ts, url, ok, amount_usd }]` on the authorization entity; `store.appendX402` + `store.endpointTrust(url)` (reuses the EMA). Journal kind `x402_purchase`.
- `WalletProvider.payX402` / `.swap` — stub simulates (clean amounts, fake tx); CDP does `useSpendPermission` (pull within the Spend Permission) → `wrapFetchWithPayment` (x402-fetch, EIP-3009) / `spender.swap(...)`. **Verify live** — x402-fetch↔CDP-account signer shape and the pull/swap ordering are from types, not a live run.
- Graph: `confirm` node resolves the x402 endpoint from the catalog, runs `evaluateGate` for the copy, and on "yes" sets `confirmedIntent`; new `execute` node (`confirm → execute` conditional) re-runs the gate on FRESH reads, calls the provider, `appendSpend` (idempotent on `confirmedIntent.id`) + `appendX402`, replies with the basescan link. ACP intents show a "next phase" message.
- Intent table split: "risk score" / "is X a rug" / "whale flows" → `x402_data_purchase`; only explicit "hire an agent" → `acp_job`.
- Tests: `execution.gate.test.ts`, `execution.catalog.test.ts`, + x402/swap/shared-cap flow in `agent.graph.test.ts`. 83 pass / 7 skip.
- **Swap DEX-liquidity risk** (plan): CDP swap API used; on thin testnet liquidity, fall back to a WETH wrap presented honestly. Not decided/exercised — no live run.

---

### Phase 6 — Virtuals ACP + trust write-back

The agent posts a real ACP job, pays via escrow (settles on Base), and **remembers whether the counterparty was worth trusting.**

**Len3 inputs:** none for the protocol. Trust-score formula and append-only history discipline carry over.

**Spike first (parallel with Phase 1):**
- Stand up the Virtuals ACP SDK, register/identify the agent, run one job end-to-end: created → escrowed → fulfilled → paid.
- **Hard go/no-go.** If it doesn't settle, cut it — do not fake it (disqualification risk). Reroute effort into hardening memory + execution + pitch.

**If kept (`execution/acp.ts`):**
- `post_acp_job` tool: job type = "assess this token's risk". Prefer hiring an **existing independently-registered** Virtuals agent; fallback = a second minimal agent with its own identity + wallet, **disclosed plainly in the README**.
- Escrow settles on Base → reuses the agent spender.
- `validateExternalData()` on the counterparty's result before it informs any decision.
- Write-back (**not optional**): `appendAcpJob({ counterparty_id, job_type, outcome_summary, trust_delta })`; `trustScore()` re-derives; the agent reads it **before** hiring again.
- Pre-seed one already-evaluated job before recording so the fresh-session demo shows the agent citing an existing trust score.

**Exit:** a job lifecycle completes; `acp_job_history` gains an entry; a second hire request reads the trust score and the agent narrates it.

**Status: trust loop done (stub); real ACP is an open go/no-go spike.**
- `src/acp/` — `AcpProvider` interface (`preferredCounterparty`, `hire`), selector on `ACP_MODE`. `StubAcpProvider` — a **`[SIMULATED]`-labelled** counterparty (`agent://ward-analyst.stub`), deterministic per-subject token-risk result, the tested path. `VirtualsAcpProvider` — real skeleton against `@virtuals-protocol/acp-node-v2` v2 (event-driven `AcpAgent` + `createJobByOfferingName`), dynamic-imported so the beta dep isn't installed; `CdpEvmProviderAdapter` (`acp/cdp-adapter.ts`) is a spike skeleton that throws.
- `src/execution/acp.ts::runAcpJob` — the loop: `preferredCounterparty` → `trustScore` (pre-hire read) → `evaluateGate(acp_job)` → `hire` → `validateExternalData` on the result → `appendSpend(acp_job)` (shared ledger) → `appendAcpJob({ …, trust_delta })` → re-derived `trustScore` narrated. `trust_delta` = delivery+integrity signal (`src/acp/trust-delta.ts`), not correctness.
- Graph: `confirm` acp_job branch cites `agent://… (trust 0.NN, N prior job(s))` before hiring; `execute` acp_job branch runs `runAcpJob`. Intent: `extractSubject()` pulls the ticker/0x-address.
- `scripts/seed-acp.ts` — pre-seed a hindsight-evaluated job for the fresh-session demo.
- `ACP.md` — the go/no-go checklist + counterparty-disclosure rules. `ACP_MODE=stub` default.
- Tests: `acp.stub.test.ts` (provider + `jobTrustDelta` + `runAcpJob` write-back + pre-seed), + ACP hire flow in `agent.graph.test.ts`. 88 pass / 7 skip.
- **Open**: the real spike (register at app.virtuals.io, implement the CDP adapter, one job end-to-end). If it doesn't settle → `ACP_MODE=stub`, cut the acp_job intent from the demo, keep the pre-seeded trust for the memory story. Never fake it.

---

### Phase 7 — Judge test harness, refusal path, revocation

Rehearse the judges' own eligibility test on the real demo surface, and make it a first-class repo artifact.

**Len3 inputs (ADAPT):** `agent/src/evals/` harness pattern; optionally `memory/session_summary.ts`.

**Build (`test/`):**
- `deletion-gate.test.ts` — seed a `UserAuthorization`, run a swap request → succeeds; **remove the `ward.authorization` entity from Sibyl Memory** (`memory_forget`, or wipe the SQLite DB); run the same request → agent refuses with a specific message; assert no tx broadcast. Runs on both backends in CI (`fs`; `sibyl-mcp` when `SIBYL_MEMORY_MCP_TEST=1`).
- `revocation.test.ts` — revoke `swap` mid-session → next swap in the *same* session refused (fresh `revocation_log` read).
- `daily-cap.test.ts` — ledger sum enforcement at/over the cap.
- `onchain-revoke.test.ts` — revoke the Spend Permission on-chain → next spend attempt refuses even with memory intact.
- `scripts/demo-deletion.sh` — performs the delete live on Telegram for the video.
- **Optional:** wire `session_summary.ts` → Sibyl Memory HOT state (`memory_set_state`, `ward.conversation.<id>`) so memory visibly *accumulates* turn over turn (strengthens the 40-pt "dynamic storage" line beyond the caps ledger).

**Exit:** `bun test` covers deletion, memory revocation, on-chain revocation, and cap enforcement; the deletion demo is scripted and rehearsed on Telegram.

**Status: done.**
- `test/support.ts` — shared harness (`hermeticSetup`/`Teardown`, `say`/`askAction`/`resume`/`confirmAction`/`onboard`, `walletCalls()` — the stub providers now log method calls so "no tx broadcast" is a real assertion).
- `test/deletion-gate.test.ts` — with record → swap executes + `spent_ledger` grows; `backend().forgetEntity("ward.authorization", …)` → same swap refuses, `walletCalls()` unchanged, `read()` still null, refusal doesn't leak the deleted caps. Also x402. Graph-level check on the live MCP backend in `memory.sibyl-mcp.test.ts`.
- `test/revocation.test.ts` — pause `swap` mid-session → next swap refused, no broadcast; other action types still work; broad revoke pauses all three.
- `test/daily-cap.test.ts` — swap+x402 on one cap; blocked at the cap, no broadcast; cheap purchase still fits; per-action limit trips first.
- `test/onchain-revoke.test.ts` — permission `status: "revoked"` (memory intact) → refused; `revocation_log` empty, caps unchanged; re-grant unblocks.
- `test/agent.summary.test.ts` — `maybeSummarize` writes/accumulates the HOT-state summary.
- **Episodic memory (done, not optional):** `memory/store.ts::readConversation`/`writeConversation` (Sibyl HOT state `ward.conversation.<id>`), `src/agent/summary.ts::maybeSummarize` (every 4 turns; LLM or deterministic key-line fallback), gateway calls it fire-and-forget, `agent` node folds it into the system prompt.
- `scripts/forget-auth.ts` (does the delete, prints before/after) + `scripts/demo-deletion.sh` (the on-camera choreography).
- 101 pass / 8 skip (fs); 105 pass / 4 skip (+ live MCP).

---

### Phase 8 — Demo, README, submission

- **README:** what's persisted, where (Sibyl Memory — `ward.authorization` / `ward.wallet` entities + COLD journal; `memory/README.md` has the tier map), what's recalled, how each field changes a decision — **grep-findable in under 2 minutes.** Memory-module `README.md` + `SIBYL-MEMORY.md` feed this.
- **Demo video (2–5 min):** fresh-session recall with a visible timestamp → the memory-gated refusal moment → one live x402 payment on Base → one live capped swap on Base → on-chain Spend Permission revoke → (ACP job if kept) → narrated as one arc: *recall → decide → pay/hire → execute, and none of it works without Sibyl Memory.*
- **ATTRIBUTION.md:** the vendored Len3 files by path, with the Len3hq IP sign-off referenced. Note Sibyl Memory (`sibyl-memory-cli[mcp]`) as the persistence layer.
- Two build-in-public posts tagging Base and Virtuals.
- Final secret sweep: no keys anywhere in history.
- PMF section — honest evidence or absent.

**Status: repo artifacts done; video + live-verification + build-in-public are operator tasks.**
- `README.md` rewritten as a submission README: the **"How memory is load-bearing"** table (field → where read → what it changes → deleted →) is the grep-findable section; partner-stack status table; honest "everything runs on stubs without keys" line; PMF section (honest, no numbers).
- `ATTRIBUTION.md` filled — the adapted Len3 components by Ward file + Len3 component + what carried over; libraries/services listed; Len3hq sign-off noted.
- `DEMO.md` — the 7-beat 2-5 min video script with exact Telegram transcripts + the `scripts/forget-auth.ts` / `seed-acp.ts` commands + the "cut the ACP beat / don't run the stub on camera" instruction.
- `SUBMISSION.md` — the checklist (repo artifacts checked, video/live-verify/posts unchecked), the two organizer questions, the submission-form answers (persisted / recalled / how-it-changes-a-decision / partner stacks), two build-in-public post drafts (Base + Virtuals), the honest PMF paragraph.
- **Secret sweep: clean.** Working tree + all 7 commits scanned — no keys, no private key material, no local memory data tracked. `.env` git-ignored; only `.env.example`. (One benign hit: `WALLET.md` has `CDP_API_KEY_SECRET=...` as a literal placeholder.)
- **Remaining (operator):** record the video; `WARD_CDP_TEST=1` + one real x402 + one real swap on Base Sepolia; the ACP go/no-go spike; post the two build-in-public posts; email the two organizer questions.

---

## 6. Phase → rubric mapping

| Phase | Rubric line it serves |
|---|---|
| 1, 7 | **Memory load-bearing (40)** — accumulating record; deletion + memory-revocation + on-chain-revocation + cap tests; grep-findable docs |
| 6 | **Innovation (25)** — agent that hires and *remembers trust in* other agents; memory as the policy layer above an on-chain permission |
| 3, 4, 5 | **Technical execution (20)** — three independent Base actions (Spend Permission grant/revoke, x402 payment, capped swap) on one enforced ledger; structural HITL interrupt; two-limit gate; input-validation boundary |
| 8 | **Pitch (15)** — one narrative arc, recorded after the loop works |
| 8 | **PMF (+10)** — honest evidence or omitted |

---

## 7. Sibyl Memory — the record (from build plan §3.1, with Len3-derived enforcement)

Persisted as a **Sibyl Memory WARM entity**, `ward.authorization` / `<telegram_id>`
(`memory_remember` / `memory_recall`). Every mutation also appends a **COLD journal
event** (`memory_record_event`, category `ward.<kind>`). Schema + API: `memory/`.

```jsonc
// entity  ward.authorization / <telegram_id>
{
  "risk_label": "moderate",                    // set once at onboarding — the only static field
  "standing_caps": {
    "per_action_limit_usd": 50,
    "daily_limit_usd": 100
  },
  "spent_ledger": [                             // append-only; sum current-UTC-day rows for the cap
    { "ts": "2026-09-05T14:02:11.000Z", "amount_usd": 30.0,
      "action_type": "swap", "tx_hash": "0x…", "idempotency_key": "…" },
    { "ts": "2026-09-05T15:20:44.000Z", "amount_usd": 0.02,
      "action_type": "x402_data_purchase", "tx_hash": "0x…", "idempotency_key": "…" }
  ],
  "revocation_log": [                           // checked fresh before every action
    { "ts": "2026-09-05T16:00:00.000Z", "action_type": "swap", "reason": "user paused trading" }
  ],
  "acp_job_history": [                          // appended after every ACP job resolves
    { "ts": "2026-09-04T…", "counterparty_id": "agent://…", "job_type": "token_risk",
      "outcome_summary": "flagged rug indicators, correct", "trust_delta": 0.2 }
  ],
  "x402_ledger": [                              // appended after every x402 purchase attempt
    { "ts": "2026-09-05T15:20:44.000Z", "url": "https://…/token-risk", "ok": true, "amount_usd": 0.05 }
  ]
  // NO trust_score field — DERIVED from acp_job_history / x402_ledger on every read (trust.ts)
}
```

```jsonc
// entity  ward.wallet / <telegram_id>
{
  "smart_account": "0x…",                       // user's CDP Embedded Wallet smart account
  "agent_spender": "0x…",                       // CDP Server Wallet
  "spend_permission": {                         // null until granted on-chain
    "token": "USDC", "allowance_usd": 100, "period_seconds": 86400,
    "granted_tx": "0x…", "status": "active"     // "revoked" after an on-chain revoke
  }
}
```

**Enforcement loop** (ported from Len3's `spending_controls_service` + `x402_service.estimate_cost`, reading Sibyl Memory + chain instead of Postgres):

- `daily_limit_usd` — `spentToday()` sums `spent_ledger` for the current UTC window, every action.
- `per_action_limit_usd` — checked against the requested amount.
- `revocation_log` — `isRevoked()` blocks a revoked `action_type` on a **fresh read** every action.
- On-chain Spend Permission — the hard outer bound; executable amount = `min(memory cap remaining, on-chain allowance remaining)`.
- `trustScore()` — derived from `acp_job_history` (recency-weighted EMA), read **before** choosing a counterparty.

**Removing the `ward.authorization` entity** takes away the agent's entire policy basis — no scope for the swap, no budget for x402, no history for the ACP hire. The chain would still permit a spend; the agent refuses because it has no memory of what it's allowed to do. That is the difference between passing the eligibility gate and winning the 40-point line.

---

## 8. Judge test harness (Phase 7 deliverable, `test/`)

| Test | Asserts |
|---|---|
| `deletion-gate.test.ts` | with record → swap succeeds; remove the `ward.authorization` entity from Sibyl Memory → same swap **refused**, **no tx broadcast** |
| `revocation.test.ts` | revoke `swap` mid-session → next swap in the same session refused (fresh read) |
| `onchain-revoke.test.ts` | revoke the Spend Permission on-chain → next spend refused even with memory intact |
| `daily-cap.test.ts` | ledger sum at/over `daily_limit_usd` → next action of either type refused or scaled down |
| `scripts/demo-deletion.sh` | performs the delete live on Telegram for the demo video |

README points at these by path so the eligibility gate is checkable from the repo alone.

---

## 9. Risk register (from the build plan, re-anchored to phases)

| Risk | Owning phase | Mitigation |
|---|---|---|
| ACP integration difficulty (two-sided, third-party) | Phase 6 spike | Hard go/no-go up front; cut cleanly, never fake |
| Wallet-connect / Spend Permission not solid | Phase 4 | Keep the single agent-owned CDP Server Wallet path working as a fallback; don't ship it as the story |
| Coinbase / CDP geoblock in the dev region | Phase 4 | `src/net.ts::installCdpProxy()` — `*.coinbase.com` via `CDP_PROXY_URL` for local dev; unset on Railway (non-blocked region). Extend the host matcher if the x402 facilitator is off `*.coinbase.com`. |
| Untrusted external input → executor | Phase 3 | `validateExternalData()` boundary; stated aloud in the pitch as the real security line |
| Testnet DEX liquidity for the swap | Phase 5 | Decide fallback (WETH wrap / self-deployed pool) early; x402 is the safer primary Base action |
| Static memory that passes the gate but scores poorly | Phase 1 + 7 | Four accumulating ledgers (`spent_ledger`, `revocation_log`, `acp_job_history`, `x402_ledger`) + the `ward.conversation` HOT-state episodic summary — done, not optional |
| Same-team ACP counterparty reading as self-dealing | Phase 6 | Prefer an existing external agent; stub is `[SIMULATED]`-labelled and never shown as real; fallback disclosed in `ACP.md` + README |
| Len3 IP / attribution | Phase 0 + 8 | `ATTRIBUTION.md` written — components by Ward file, no verbatim copies; Len3hq sign-off still to be recorded |
| CDP / x402 / ACP paths not live-verified (no keys during the build) | Phase 4–6 + 8 | Every SDK surface isolated in one file per integration (`wallet/cdp.ts`, `acp/virtuals.ts`); opt-in live tests (`WARD_CDP_TEST`, `WARD_CDP_TEST`+facilitator, `ACP_MODE=virtuals`); deterministic stubs are the demo-day hedge, disclosed honestly |
| Sibyl Memory MCP wire contract / plugin upgrade breaking calls | Phase 1 | Contract **verified against live `sibyl-memory-mcp` 0.2.0**; `sibyl-mcp.ts` isolates all tool names / arg keys in one map; `SIBYL_MEMORY_MCP_TEST=1 bun test` re-checks after any upgrade; `fs` backend is the demo-day hedge |
| Overclaiming custody | Phase 4 + Phase 8 | State plainly: managed-MPC wallets (Coinbase CDP) + an on-chain Spend Permission — non-custodial and revocable, not an audited production custody stack |

---

## 10. Open items

All code phases (0–8 repo artifacts) are done. What's left is operator/verification
work — see `SUBMISSION.md` for the tracked checklist.

- [ ] Email the organizers: does a failed deletion gate zero the whole score or just the 40-pt line? (LICENSE = MIT, already in place.)
- [x] LICENSE: MIT. Sibyl Memory = the official `sibyl-memory-cli[mcp]` plugin (resolved 2026-09-02).
- [x] `memory_*` wire contract verified against live `sibyl-memory-mcp` 0.2.0. Remaining: `sibyl init` for Pro-tier activation before submission.
- [x] Len3 attribution written (`ATTRIBUTION.md` — components by file, no verbatim copies). Remaining: Len3hq sign-off on record.
- [x] Secret sweep — clean (working tree + all commits).
- [ ] Confirm hackathon rules on repo creation date / forks.
- [ ] Record the 2–5 min demo video (`DEMO.md`).
- [ ] Coinbase CDP: get API keys; `WARD_CDP_TEST=1 bun test test/wallet.cdp.test.ts` to confirm the SDK field names; note the Spend Permission Manager address on Base Sepolia.
- [ ] Base: RPC endpoint; one real x402 payment + one real capped swap on Base Sepolia (`WARD_CDP_TEST`-style); an x402 endpoint that accepts Base payments (swap the placeholder URLs in `memory/catalog/x402-catalog.json`); decide the swap fallback (WETH wrap) if testnet DEX liquidity is thin.
- [ ] Virtuals ACP: the go/no-go spike (`ACP.md`) — register at app.virtuals.io, implement `src/acp/cdp-adapter.ts`, one job end-to-end. If it doesn't settle → `ACP_MODE=stub`, cut the ACP demo beat.
- [ ] Two build-in-public posts (drafts in `SUBMISSION.md`), tagging Base and Virtuals.
