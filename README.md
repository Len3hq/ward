# Ward

**A personal crypto agent whose memory is the authorization layer for moving money
on Base.**

Ward cannot exceed the limits you once gave it, and it gets better at knowing which
other agents to trust — because that policy lives in [Sibyl
Memory](./SIBYL-MEMORY.md), not in code. Delete the memory and the agent has no
basis for authority: it refuses to act, even when the chain would still permit the
spend.

> _An agent that cannot exceed what you once told it, and gets better at knowing
> who else to trust, because it remembers._

## What it does

On Telegram, in one loop:

1. **Onboards once** — risk label, per-action limit, daily limit → written to Sibyl
   Memory.
2. **Connects a wallet** — a Coinbase CDP smart account for you, a CDP Server
   Account as the agent spender, and a **revocable on-chain USDC Spend Permission**
   scoped to your daily limit.
3. **Acts within `min(memory cap, on-chain allowance)`** — a capped swap on Base, or
   an [x402](https://www.x402.org/) payment for premium on-chain data, or hiring
   another agent via [Virtuals ACP](https://virtuals.io/) to assess a token — all on
   **one spending ledger**, every one confirmed with the real numbers.
4. **Remembers** — every spend, every revocation, and whether each counterparty was
   worth trusting. A fresh session recalls all of it.

## How memory is load-bearing

Every field except `risk_label` grows only through use. Each is read on the
critical path; delete the record and each read fails closed.

| Sibyl Memory field                                                                     | Where it's read                                                                                           | What it changes                                                                      | Deleted →                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `ward.authorization/<id>` (the record)                                                 | [`memory/store.ts` `read()`](./memory/store.ts) — `src/agent/nodes/router.ts`, `execute.ts`, `confirm.ts` | exists? → proceed · missing? → **refuse, explain why**                               | every action request is refused; no scope, no budget, no trust    |
| `standing_caps.per_action_limit_usd`                                                   | [`src/execution/gate.ts`](./src/execution/gate.ts) `evaluateGate`                                         | amount over it → blocked before any confirmation                                     | —                                                                 |
| `standing_caps.daily_limit_usd`                                                        | `gate.ts`, via `spentToday()`                                                                             | `sum(spent_ledger, today) + amount > cap` → blocked                                  | —                                                                 |
| `spent_ledger[]` (append-only)                                                         | `spentToday()` — sums swap + x402 + acp_job for the current UTC day                                       | one number, one cap, across every action type                                        | the cap is unbounded (but there's no record, so it refuses first) |
| `revocation_log[]` (append-only)                                                       | `isRevoked()` — **fresh read before every action**                                                        | a revoked `action_type` blocks that path immediately, mid-session                    | —                                                                 |
| `acp_job_history[]` (append-only)                                                      | `trustScore()` — read **before** choosing a counterparty                                                  | a low-trust counterparty is flagged; the agent narrates `0.56 → 0.60` after each job | the agent has no memory of who it trusts                          |
| `x402_ledger[]` (append-only)                                                          | `endpointTrust()`                                                                                         | per-endpoint success/failure feeds a derived trust score                             | —                                                                 |
| `ward.wallet/<id>.spend_permission.status`                                             | `confirm.ts` / `execute.ts`                                                                               | `"revoked"` → refuse even with the memory record intact (the two-limit design)       | —                                                                 |
| `ward.conversation.<id>` (HOT state, [`src/agent/summary.ts`](./src/agent/summary.ts)) | the `agent` node's system prompt                                                                          | a fresh session recalls the _conversation_, not just the caps                        | —                                                                 |

The tier map, the exact JSON shape, and which function touches which field are in
[`memory/README.md`](./memory/README.md).

## The demo

_recall → decide → pay/hire → execute — and none of it works without Sibyl Memory._

Fresh-session recall (timestamped) → the memory-gated refusal → one x402 payment on
Base → one capped swap on Base → revoke the Spend Permission on-chain → an ACP hire
with trust write-back. Full script: [DEMO.md](./DEMO.md).

## Architecture

One Bun + TypeScript process. No backend, no database of our own, no vector store.

- **Agent** — LangGraph, `MemorySaver` for per-thread turn state ·
  [`src/agent/`](./src/agent/). Flow: guard → intent → router, branching to
  onboarding / agent / refuse / confirm / wallet; `confirm → execute`;
  `agent ⇄ tools`.
- **Memory** — [Sibyl Memory](./SIBYL-MEMORY.md) (`sibyl-memory-cli[mcp]` — local
  SQLite, FTS5, no vector DB), reached from the Bun process over the
  `sibyl-memory-mcp` stdio server · [`memory/`](./memory/).
- **Wallet** — CDP smart account + CDP Server Account spender + on-chain Spend
  Permission · [`src/wallet/`](./src/wallet/), [WALLET.md](./WALLET.md).
- **Base execution** — the shared gate + a keyword-matched x402 catalog (GET or
  POST-with-body, `{subject}`-templated) + the x402 / swap / ACP paths ·
  [`src/execution/`](./src/execution/), [X402.md](./X402.md).
- **Counterparty market** — Virtuals ACP hire with trust write-back ·
  [`src/acp/`](./src/acp/), [ACP.md](./ACP.md).
- **Interface** — Telegram (Telegraf; streamed edits, HTML, 4096-split, typed
  confirmations) · [`src/telegram/`](./src/telegram/) — and Discord (discord.js;
  DM-only, native markdown, 2000-split, button confirmations) ·
  [`src/discord/`](./src/discord/). Both drive one channel-free turn loop in
  [`src/gateway/`](./src/gateway/), against one authorization record: linked
  accounts share a daily cap, a spend ledger and every revocation. Ward is also an
  **MCP server** ([`src/mcp/`](./src/mcp/), [`MCP.md`](./MCP.md)) — read-mostly by
  design: an MCP client can propose a spend but never approve one, because it holds
  a token rather than being a person. See
  [`MULTI-CHANNEL.md`](./MULTI-CHANNEL.md).

Build history and every design decision: [Ward-Build-Phases-and-Len3-Infra-Map.md](./Ward-Build-Phases-and-Len3-Infra-Map.md).

## Eligibility gate — checkable from the repo

The judges' own tests, as first-class CI test files:

| File                                                           | Asserts                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`test/deletion-gate.test.ts`](./test/deletion-gate.test.ts)   | with the record a swap executes; remove `ward.authorization` from Sibyl Memory → the same request refuses, **no transaction broadcast** |
| [`test/revocation.test.ts`](./test/revocation.test.ts)         | pause `swap` mid-session → the next swap in that session is refused (fresh `revocation_log` read)                                       |
| [`test/onchain-revoke.test.ts`](./test/onchain-revoke.test.ts) | revoke the Spend Permission on-chain → the next spend refuses even with memory intact                                                   |
| [`test/daily-cap.test.ts`](./test/daily-cap.test.ts)           | `spent_ledger` sum at/over `daily_limit_usd` → the next action of either type is blocked                                                |

The stub wallet / ACP providers log every call, so "no transaction broadcast" is an
assertion, not a comment. `deletion-gate` runs on the `fs` backend in CI and on the
real `sibyl-mcp` backend under `SIBYL_MEMORY_MCP_TEST=1`
([`test/memory.sibyl-mcp.test.ts`](./test/memory.sibyl-mcp.test.ts)).
[`scripts/demo-deletion.sh`](./scripts/demo-deletion.sh) does it live on Telegram.

```sh
bun test          # 101 pass on the fs backend
```

## Partner stacks (Base ×1.15, Virtuals ×1.25)

**Base** — three of the four qualifying actions from the rules:

| Action                                                 | Path                                                                         | Status                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Contract interaction — Spend Permission grant / revoke | `src/wallet/cdp.ts` `createSpendPermission` / `revokeSpendPermission`        | code-complete; CDP field names from SDK types, **verify live** (`WARD_CDP_TEST=1`) |
| x402 payment                                           | `src/wallet/cdp.ts` `payX402` (`x402-fetch`, EIP-3009, Coinbase facilitator) | code-complete; **verify live**                                                     |
| Wallet operation — capped swap                         | `src/wallet/cdp.ts` `swap` (CDP swap API, pull-within-permission)            | code-complete; **verify live**                                                     |

**Virtuals ACP** — `hire an agent to assess PEPE` → job → escrow (settles on Base) →
`validateExternalData` on the result → `appendAcpJob({…, trust_delta})` → the next
hire reads the re-derived trust score. **The trust loop works today against a
`[SIMULATED]` counterparty.** The real path (`ACP_MODE=virtuals`) is a hard
go/no-go spike — [ACP.md](./ACP.md). If it doesn't settle end-to-end, it's cut
cleanly, never faked.

An ACP job is charged to **the user's** wallet, pulled through their Spend
Permission like any other spend — not absorbed by a Ward-side float. The wallets
Ward runs are conduits, not floats; see the funding table in [ACP.md](./ACP.md).

**Counterparty disclosure.** The seller agent Ward hires on the real path
([`counterparty/`](./counterparty/)) has its own ACP registration, wallet and key,
and settles real escrow — but it is **run by the same team as Ward**, not an
independent third party. It sells a reproducible token-risk report (every report
cites its sources and the sha256 of the response it was derived from, so the work
can be re-run rather than trusted). Prefer an independently-registered agent if one
offers the service.

Without keys, everything runs on deterministic stubs (`SIBYL_MEMORY_MODE=fs`, no
`CDP_*`, `ACP_MODE=stub`, no `OPENAI_API_KEY`) — enough to demo the whole memory
loop.

## Run it

```sh
bun install
cp .env.example .env               # TELEGRAM_BOT_TOKEN from @BotFather,
                                   # and/or DISCORD_BOT_TOKEN — at least one

pipx install 'sibyl-memory-cli[mcp]'   # Python 3.10+ — see SIBYL-MEMORY.md
sibyl init                              # or run with SIBYL_MEMORY_MODE=fs

bun run dev
```

`OPENAI_API_KEY` → the `gpt-4o-mini` conversational model. `CDP_*` → the real
wallet. `ACP_MODE=virtuals` + `ACP_*` → the real counterparty market. See
[`.env.example`](./.env.example).

## Product-market fit

No fabricated numbers. The validated pain point is public and well-documented:
crypto users will not give an autonomous agent unrestricted spend authority — "the
agent has my keys" is the standing objection in every agent-trading thread. Ward's
answer is a memory-scoped, on-chain-revocable authorization layer where the limits
are the user's and the agent's own policy can only be stricter. There is no
waitlist or usage to cite; this section is honest and modest by design.

## Troubleshooting

- **Any Coinbase / CDP / x402-facilitator call fails** (timeout, `403`/`451`,
  "region not supported", TLS reset): suspect the **geoblock first**, before the
  SDK usage. Coinbase blocks some regions. Check `CDP_PROXY_URL` is set for local
  dev, the boot log printed `CDP proxy active for *.coinbase.com …`, and the
  failing host matches `*.coinbase.com` (widen `isCoinbaseHost()` in
  [`src/net.ts`](./src/net.ts) if not). Verify with
  `curl -x "$CDP_PROXY_URL" https://api.cdp.coinbase.com/`. `@coinbase/cdp-sdk` has
  no per-client fetch option, so the global `fetch` patch in `src/net.ts` is the
  only hook. On Railway (non-blocked region) leave `CDP_PROXY_URL` unset.

## Attribution

Ward adapts a small, named set of components from the **Len3** production system,
with Len3hq's sign-off. See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT — see [LICENSE](./LICENSE).
