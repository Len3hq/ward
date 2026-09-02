# Ward

A personal crypto agent whose file-based memory is the authorization substrate for
money movement on Base.

Ward cannot exceed the limits you once gave it, and it gets better at knowing which
counterparties to trust — because that policy lives in a file, not in code. Delete
the file and the agent has no basis for authority: it refuses to act, even when the
chain would still permit a spend.

## Status

**Phase 1 — Sibyl Memory module.** The full, dependency-ordered build plan is in
[Ward-Build-Phases-and-Len3-Infra-Map.md](./Ward-Build-Phases-and-Len3-Infra-Map.md).

## Architecture

One Bun + TypeScript process. No backend, no database of our own, no vector store.

- **Agent** — LangGraph (`guard → router → (onboarding | agent) → approval → tools`)
- **Interface** — Telegram (Telegraf, long-polling); `/newsession` triggers fresh-session recall
- **Memory** — [**Sibyl Memory**](./SIBYL-MEMORY.md) (the `sibyl-memory-cli[mcp]`
  plugin — local-first SQLite, no vector DB), reached over the `sibyl-memory-mcp`
  stdio server. One accumulating authorization entity per user (standing caps,
  spent ledger, revocation log, counterparty trust) + an append-only journal.
  Adapter and domain API in [`memory/`](./memory/).
- **Base execution** — x402 data payments, capped swaps, and on-chain Spend
  Permission grant/revoke, all sharing one memory-enforced spending ledger
- **Wallets** — Coinbase CDP Embedded Wallet (user) + CDP Server Wallet (agent
  spender) + a revocable on-chain Spend Permission
- **Counterparty market** — Virtuals ACP job with trust write-back (conditional on a
  go/no-go spike)

Every execution runs the same two-limit gate: `executable = min(memory cap
remaining, on-chain allowance remaining)`.

## Develop

```sh
bun install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN (from @BotFather)

# Sibyl Memory (the persistence layer) — see SIBYL-MEMORY.md
pip install 'sibyl-memory-cli[mcp]'   # Python 3.10+
sibyl init                             # browser activation
# ...or run offline with SIBYL_MEMORY_MODE=fs

bun run dev               # connects to Telegram, echoes messages
```

Other scripts: `bun run typecheck`, `bun run lint`, `bun test` (the memory suite
runs against the `fs` backend, so it needs no Sibyl install).

## Memory

Persisted in [Sibyl Memory](./SIBYL-MEMORY.md). The tier map, the record format,
and which function touches which field are in
[memory/README.md](./memory/README.md).

## Attribution

Ward deliberately vendors a small, named set of files from the **Len3** production
system, with permission. See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT — see [LICENSE](./LICENSE).
