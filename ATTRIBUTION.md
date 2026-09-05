# Attribution

Ward adapts a small, named set of components from the **Len3** production system (a
personal crypto portfolio-intelligence agent), with Len3hq's sign-off. This is not
a fork — most of Len3 (portfolio sync, P&L / risk pipelines, RAG / pgvector,
Celery, the FastAPI backend, ~55 DB models) is out of scope. What was carried over
is the shape of a few well-worn pieces, reimplemented for Ward's stack (Bun +
TypeScript, Sibyl Memory instead of Postgres, Base instead of Solana, Coinbase CDP
instead of Privy).

No Len3 source files are copied verbatim. Each item below is the _pattern_ —
topology, decision function, or flow — reimplemented against
[`Len3-System-Overview.md`](../base%20hackathon/Len3-System-Overview.md), the
code-derived map of the Len3 system.

## Adapted

| Ward file                                                      | Len3 component                                                               | What carried over                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/agent/graph.ts`                                           | `agent/src/graph/` (StateGraph + nodes)                                      | The `guard → router → (onboarding \| agent)` topology, `agent ⇄ tools`, `agent → approval → tools`; `MessagesAnnotation` + per-turn state. `PostgresSaver` → `MemorySaver`; durable state → Sibyl Memory.                                              |
| `src/agent/nodes/confirm.ts`, `nodes/approval.ts`              | `graph/nodes/approval.ts`                                                    | The structural HITL payment gate: `interrupt({ type, cost, … })`, gateway resumes with `Command({ resume: { approved } })`. Not prompt-mediated.                                                                                                       |
| `src/telegram/gateway.ts`                                      | `gateways/telegram.ts`                                                       | Telegraf long-polling, streamed message edits, markdown→HTML, 4096-char split, interrupt detection, `/newsession` / `/defaultsession`. Linking / JWT stripped — user = Telegram id.                                                                    |
| `src/agent/guardrails.ts`                                      | `security/guardrails.ts`                                                     | Explicit-injection hard block, suspicious-pattern flag, crypto keyword fast-path, `sanitizeUrls` trusted-host allowlist, `<user_input>` wrapping, `validateExternalData()` between any external payload and the LLM / executor.                        |
| `src/agent/intent.ts`                                          | `routing/intentTables.ts`                                                    | The deterministic pre-LLM intent table, collapsed to Ward's action set; one `gpt-4o-mini` structured call for the rest.                                                                                                                                |
| `src/execution/gate.ts`                                        | `backend/services/x402_service.py::estimate_cost` / `requires_approval`      | The approval-gate decision function (per-request / daily / first-time-endpoint / auto-limit), ported to TS and pointed at Sibyl Memory + the on-chain Spend Permission.                                                                                |
| `src/wallet/cdp.ts`, `src/execution/x402` path                 | `backend/services/x402_client.py` + `catalog_provider.py`                    | The request → `402` → pay → retry-with-proof → receipt orchestration; the env-driven catalog concept (pgvector search → static `x402-catalog.json` + keyword match). Solana/Privy transfer → Base x402 (`x402-fetch`, EIP-3009, Coinbase facilitator). |
| `memory/trust.ts`                                              | `x402_service` trust scoring (tier base + success-ratio weighting + recency) | The formula, reused for both x402 endpoints and ACP counterparties; counters in memory, score derived on read.                                                                                                                                         |
| `src/wallet/`                                                  | `backend/services/privy/*`                                                   | The _pattern_ only — a provider-managed MPC wallet the agent controls + a facilitator/relayed-payment flow. Provider swapped Privy → Coinbase CDP.                                                                                                     |
| `src/config.ts`                                                | `agent/src/config.ts`                                                        | Env-config loader + `MODELS` map + brand constants, trimmed.                                                                                                                                                                                           |
| `src/agent/prompts.ts`                                         | `agent/src/prompts/`                                                         | System-prompt structure (persona + profile + context + intent hint); the one-canned-question-per-turn onboarding pattern. Content rewritten for Ward.                                                                                                  |
| `src/agent/summary.ts`                                         | `agent/src/memory/session_summary.ts`                                        | Per-user buffer → idle-triggered summary → append to durable memory. Written to Sibyl Memory HOT state instead of a vector doc.                                                                                                                        |
| `test/` (deletion-gate, revocation, daily-cap, onchain-revoke) | `agent/src/evals/`                                                           | The behavioural eval-harness pattern, repurposed as the judge-facing eligibility-gate tests.                                                                                                                                                           |

Design references that informed new code with nothing carried over:
`SpendingControls` + `spending_controls_service.py` (the `standing_caps` /
`spent_ledger` / `revocation_log` enforcement loop), `AgentWalletTransaction`
(ledger-entry shape + `external_id` idempotency), `financial_ledger_service.py`
(append-only discipline), `X402Service.request_premium_data`
(reserve→check→refresh→deduct order).

## Third-party services and libraries

- **Sibyl Memory** — `sibyl-memory-cli`, `sibyl-memory-mcp`, `sibyl-memory-client`.
  The persistence layer, used over MCP as an external dependency. See
  [SIBYL-MEMORY.md](./SIBYL-MEMORY.md).
- **Coinbase CDP** — `@coinbase/cdp-sdk` (wallets, Spend Permissions, swaps).
- **x402** — `x402`, `x402-fetch`.
- **Virtuals ACP** — `@virtuals-protocol/acp-node-v2` (loaded only for the real
  counterparty spike). See [ACP.md](./ACP.md).
- **LangGraph** — `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`.
- **Telegraf** (Telegram), **discord.js** (Discord, DM-only).
- **@modelcontextprotocol/sdk** — used in both directions: as a _client_ to Sibyl
  Memory, and as a _server_ so Ward itself is an MCP surface. See [MCP.md](./MCP.md).
- **viem**, **zod**.

## License

Len3 material is used under the terms agreed with Len3hq and is compatible with
Ward's MIT license (see [LICENSE](./LICENSE)).
