# Ward

A personal crypto agent whose file-based memory is the authorization substrate for
money movement on Base.

Ward cannot exceed the limits you once gave it, and it gets better at knowing which
counterparties to trust — because that policy lives in a file, not in code. Delete
the file and the agent has no basis for authority: it refuses to act, even when the
chain would still permit a spend.

## Status

**Phase 4 — wallet & Spend Permissions.** `connect my wallet` creates a Coinbase
CDP smart account + agent spender; `grant a $100 daily permission` puts a revocable
USDC Spend Permission on Base; a swap confirmation now enforces `executable =
min(memory cap remaining, on-chain allowance remaining)` and a revoked permission
makes the next spend refuse. See [WALLET.md](./WALLET.md). The full,
dependency-ordered build plan is in
[Ward-Build-Phases-and-Len3-Infra-Map.md](./Ward-Build-Phases-and-Len3-Infra-Map.md).

## Architecture

One Bun + TypeScript process. No backend, no database of our own, no vector store.

- **Agent** — LangGraph with a `MemorySaver` checkpointer for per-thread turn
  state · [`src/agent/`](./src/agent/). Nodes: guard, intent, router, onboarding,
  agent, refuse, confirm, wallet, approval, tools.
- **Wallet** — Coinbase CDP smart account (user) + CDP Server Account (agent
  spender) + a revocable on-chain USDC Spend Permission ·
  [`src/wallet/`](./src/wallet/), [WALLET.md](./WALLET.md). Falls back to a
  deterministic stub with no CDP keys.
- **Interface** — Telegram (Telegraf, long-polling; streamed edits, HTML, 4096
  split, confirmation resume); `/newsession` / `/defaultsession` ·
  [`src/telegram/`](./src/telegram/)
- **Memory** — [**Sibyl Memory**](./SIBYL-MEMORY.md) (the `sibyl-memory-cli[mcp]`
  plugin — local-first SQLite, no vector DB), reached over the `sibyl-memory-mcp`
  stdio server. One accumulating authorization entity per user (standing caps,
  spent ledger, revocation log, counterparty trust) + an append-only journal.
  Adapter and domain API in [`memory/`](./memory/).
- **Base execution** — x402 data payments and capped swaps, sharing one
  memory-enforced spending ledger _(Phase 5)_
- **Counterparty market** — Virtuals ACP job with trust write-back _(Phase 6,
  conditional on a go/no-go spike)_

Every execution runs the same two-limit gate: `executable = min(memory cap
remaining, on-chain allowance remaining)`.

## Develop

```sh
bun install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN (from @BotFather)

# Sibyl Memory (the persistence layer) — see SIBYL-MEMORY.md
pipx install 'sibyl-memory-cli[mcp]'  # Python 3.10+ ; runs unactivated for dev
# ...or run offline with SIBYL_MEMORY_MODE=fs

bun run dev               # connects to Telegram, runs the agent graph
```

Set `OPENAI_API_KEY` for the conversational model (`gpt-4o-mini`); without it the
agent node falls back to a deterministic recall of the authorization context
(enough to demo fresh-session memory).

Coinbase geoblocks some regions — for local dev there, set `CDP_PROXY_URL` to an
HTTP(S) proxy (only `*.coinbase.com` traffic is routed through it). A deploy in a
non-blocked region (e.g. Railway) leaves it unset.

Other scripts: `bun run typecheck`, `bun run lint`, `bun test` (the memory suite
runs against the `fs` backend, so it needs no Sibyl install).

## Memory

Persisted in [Sibyl Memory](./SIBYL-MEMORY.md). The tier map, the record format,
and which function touches which field are in
[memory/README.md](./memory/README.md).

## Troubleshooting

- **Any Coinbase / CDP / x402-facilitator call fails** (timeout, `403`/`451`,
  "region not supported", TLS reset): suspect the **geoblock first**, before the
  SDK usage. Coinbase blocks some regions. Check `CDP_PROXY_URL` is set for local
  dev, that the boot log printed `CDP proxy active for *.coinbase.com …`, and that
  the failing host actually matches `*.coinbase.com` (widen `isCoinbaseHost()` in
  [`src/net.ts`](./src/net.ts) if not). Verify the proxy with
  `curl -x "$CDP_PROXY_URL" https://api.cdp.coinbase.com/`. `@coinbase/cdp-sdk` has
  no per-client fetch option, so the global `fetch` patch in `src/net.ts` is the
  only hook. On Railway (non-blocked region) leave `CDP_PROXY_URL` unset.

## Attribution

Ward deliberately vendors a small, named set of files from the **Len3** production
system, with permission. See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT — see [LICENSE](./LICENSE).
