# Ward as an MCP server

The third surface, and the one that tests the project's own claim hardest.

Telegram and Discord prove identity with an account: a DM is already authenticated,
so the account _is_ the person. An MCP client has neither. It is a local process
holding a bearer token, started by whatever wrote that token into a config file.
There is nobody on the other end of the stdio pipe to ask.

So this surface is read-mostly, and **the omission is the design**.

## What it can and cannot do

|                                                                        |                                |
| ---------------------------------------------------------------------- | ------------------------------ |
| Read the authorization record — caps, spend today, revocations, wallet | yes                            |
| Read the spend / x402 / ACP ledgers                                    | yes                            |
| See which accounts share the principal                                 | yes                            |
| **Propose** a spend                                                    | yes                            |
| **Approve** a spend                                                    | **no — there is no such tool** |

`ward_propose_action` does not execute. It queues the request; the main Ward process
delivers it to the user on Telegram or Discord and **replays the request text through
the ordinary graph there**, so it meets the same intent parser, the same gate, the
same caps and the same confirmation as if the user had typed it. Nothing about
arriving via MCP makes a spend cheaper to obtain — the client bought the user's
attention, not their authority.

A leaked token therefore cannot move money. It can only ask someone to.

This is the deletion gate's argument extended to a caller who cannot be a person:
delete the authorization entity and every tool here refuses too.

## Setup

**1. Mint a token** from an authenticated DM — Telegram or Discord:

```
/link mcp
```

Ward replies with a `wardmcp_…` token, once. It is stored only as a sha256 under
`ward.identity/mcp:<hash>`, so what lands in Sibyl Memory is not a credential:
reading the store does not get you in.

**2. Put it in the MCP client's config.** For Claude Code, `.mcp.json`:

```json
{
  "mcpServers": {
    "ward": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/ward/src/mcp/server.ts"],
      "env": {
        "WARD_USER_TOKEN": "wardmcp_…",
        "SIBYL_MEMORY_MODE": "sibyl-mcp"
      }
    }
  }
}
```

The server reads the same Sibyl Memory as the running Ward process, so it needs the
same `SIBYL_MEMORY_*` environment the main process uses.

**3. Revoke** — every token at once, deliberately:

```
/unlink mcp
```

All of them, not just the newest. "Revoke my MCP access" must not leave a second
token the user forgot they minted still working. Chat accounts are unlinked one at a
time; a credential is not.

## Tools

| Tool                      | Returns                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ward_whoami`             | The principal, every account sharing it, and whether an authorization record exists                              |
| `ward_read_authorization` | Risk profile, per-action and daily caps, spent today, remaining, revocations, wallet and spend-permission status |
| `ward_recent_activity`    | Recent spend, x402 and ACP entries, newest first                                                                 |
| `ward_link_status`        | Whether this client is bound, and which channel would confirm a proposal                                         |
| `ward_propose_action`     | Queues a request for the user to confirm on a human channel; returns a proposal id                               |

A token is never echoed back to the client that presented it, and neither is its
digest — the digest is as good as the credential for lookup. Ledger rows carry
counterparty-supplied text, so `ward_recent_activity` wraps its output in
`<untrusted_data>` on the way out: it is data, never instruction.

## How delivery works

The MCP server runs as its **own process**, spawned by the MCP client over stdio. It
cannot reach a running gateway, so it queues proposals in Sibyl Memory
(`ward.proposals`) and `src/gateway/proposals.ts` polls for them inside the main Ward
process, every 5 seconds.

Both halves must be running: an MCP client alone can queue a proposal, but nothing
will deliver it until `bun run start` is up with a gateway configured. A proposal with
nowhere to go waits in the queue rather than vanishing.

**A known limitation, stated plainly.** That queue document is written by one process
and drained by another, and the in-process write lock cannot span them. A simultaneous
append and drain could lose a proposal. It is accepted rather than hidden: proposals
arrive at human speed, a lost one is a missing notification rather than an
unauthorised spend, and nothing on this surface can move money on its own. If it ever
gets busy, it wants a real queue.

## Files

| File                       | Role                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `src/mcp/server.ts`        | The tools, the token guard, and the entrypoint                           |
| `src/mcp/token.ts`         | Mint / resolve / revoke the bearer token; only sha256 digests are stored |
| `src/gateway/proposals.ts` | Polls the queue and replays each proposal as a real turn                 |
| `src/gateway/channels.ts`  | The live-gateway registry a pushed turn needs                            |
| `test/mcp.server.test.ts`  | 17 tests, including the deletion gate and "silence is never approval"    |
