# Sibyl Memory setup

Ward persists its authorization substrate in **Sibyl Memory** — the
`sibyl-memory-cli[mcp]` plugin (local-first SQLite + FTS5, five-tier schema, no
vector DB). Ward's Bun process is an MCP client of the `sibyl-memory-mcp` stdio
server; `memory/backends/sibyl-mcp.ts` is the adapter.

## Install (per machine)

```sh
pipx install 'sibyl-memory-cli[mcp]'    # or: pip install — needs Python 3.10+
```

This installs three console scripts into the venv: `sibyl`, `sibyl-memory-mcp`,
`sibyl-memory-hermes`. `pipx` only links `sibyl` onto `PATH` by default — expose
the MCP server too:

```sh
ln -sf "$(pipx environment --value PIPX_LOCAL_VENVS)/sibyl-memory-cli/bin/sibyl-memory-mcp" ~/.local/bin/
# or set SIBYL_MEMORY_MCP_COMMAND to its absolute path in .env
```

The server runs **unactivated** against a local SQLite DB
(`~/.sibyl-memory/memory.db`, tenant `00000000-…-0001`) — enough for dev and the
whole test suite. For the hackathon submission, activate the Pro tier:

```sh
sibyl init       # opens the browser — sign in with email or wallet
sibyl status     # confirms tier + DB location
```

Ward does **not** need `sibyl setup` — that wires Sibyl into other MCP _hosts_
(Claude Code, Codex, Hermes). Ward speaks to `sibyl-memory-mcp` directly.

## Configuration

| Env var                    | Default                            | Purpose                                                                    |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `SIBYL_MEMORY_MODE`        | `sibyl-mcp`                        | `sibyl-mcp` = the real path · `fs` = hermetic JSON files (tests / offline) |
| `SIBYL_MEMORY_MCP_COMMAND` | `sibyl-memory-mcp`                 | server binary / launcher                                                   |
| `SIBYL_MEMORY_DB`          | `~/.sibyl-memory/memory.db`        | SQLite path (a throwaway path isolates a test run)                         |
| `SIBYL_CREDENTIALS`        | `~/.sibyl-memory/credentials.json` | credentials file                                                           |
| `SIBYL_MEMORY_MCP_DEBUG`   | _unset_                            | any value → forward the server's stderr                                    |

Without the plugin, run with `SIBYL_MEMORY_MODE=fs`. The `fs` backend is **not the
judged path** — it exists so `bun test` and offline dev work without Python 3.10+.
CI runs in `fs` mode.

## Wire contract

Verified against `sibyl-memory-mcp` 0.2.0 (`tools/list` + live calls). The adapter
uses 6 of the 8 tools:

| Ward call      | MCP tool              | args                          | result                                                          |
| -------------- | --------------------- | ----------------------------- | --------------------------------------------------------------- |
| `getEntity`    | `memory_recall`       | `{ category, name }`          | `{ ok, entity: { body } }` · `isError` `NOT_FOUND` when absent  |
| `putEntity`    | `memory_remember`     | `{ category, name, body }`    | `{ ok, category, name }`                                        |
| `appendEvent`  | `memory_record_event` | `{ kind, category, body }`    | `{ ok, event_id, kind }`                                        |
| `getState`     | `memory_get_state`    | `{ key }`                     | `{ ok, body }` · `{ ok: false, code: "NOT_FOUND" }` when absent |
| `setState`     | `memory_set_state`    | `{ key, body }`               | `{ ok, key }`                                                   |
| `forgetEntity` | `memory_forget`       | `{ category, name, reason? }` | `{ ok, archived }`                                              |

`memory_recall` / `memory_get_state` results also carry an `_untrusted_context`
envelope (Sibyl's prompt-injection guard on stored values) — the store returns
`entity.body` / `body` only; the guard note is handled where memory reaches the
LLM (Phase 2–3).

Re-verify after a plugin upgrade:

```sh
SIBYL_MEMORY_MCP_TEST=1 bun test test/memory.sibyl-mcp.test.ts
```

If a call breaks, fix only the `TOOL` map + arg keys in `sibyl-mcp.ts`.

## The deletion gate

The eligibility test runs against this layer:

1. Onboard a user → the `ward.authorization/<id>` entity exists → a swap request
   succeeds.
2. `memory_forget` that entity (or wipe `~/.sibyl-memory/memory.db`).
3. The same swap request → `read()` returns `null` → the agent refuses and
   explains why. No transaction is broadcast.

`test/memory.sibyl-mcp.test.ts` covers step 1→3 at the store level today;
`deletion-gate.test.ts` + `scripts/demo-deletion.sh` (Phase 7) do it on the
Telegram surface.
