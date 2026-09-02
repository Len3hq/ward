# Attribution

Ward deliberately vendors a small, named set of files from the **Len3** production
system (a personal crypto portfolio-intelligence agent), with permission from Len3hq.
This is not a fork: most of Len3 is out of scope. The vendor list is intentionally
short and enumerated here.

Every vendored source file carries a header comment pointing back to this document.

## Vendored (copied with minimal edits)

_None yet — vendoring begins in Phase 2._

| Ward path | Len3 source path | Adaptation |
| --------- | ---------------- | ---------- |
| —         | —                | —          |

## Ported (logic reimplemented in TypeScript, no code copied)

| Ward path | Len3 source | Notes |
| --------- | ----------- | ----- |
| —         | —           | —     |

## Third-party services

- **Sibyl Memory** (`sibyl-memory-cli`, `sibyl-memory-mcp`, `sibyl-memory-client`) —
  the persistence layer. Used as an external dependency over MCP, not vendored. See
  [SIBYL-MEMORY.md](./SIBYL-MEMORY.md).

## License

Len3 material is vendored under the terms agreed with Len3hq and is compatible with
Ward's MIT license (see [LICENSE](./LICENSE)).
