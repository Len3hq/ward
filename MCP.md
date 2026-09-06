# Ward as an MCP server

The third surface, and the one that tests the project's own claim hardest.

Telegram and Discord prove identity with an account: a DM is already authenticated,
so the account _is_ the person. An MCP client has neither. It is a local process
holding a bearer token, started by whatever wrote that token into a config file.
There is nobody on the other end of the stdio pipe to ask.

So this surface is **propose-only by default**, and that default is the design.

A client can be given an explicit, capped, expiring **execution grant** (Phase 16.3),
issued from an authenticated DM and revocable in one message — but it has one only if
the user deliberately gave it one, and until then there is no tool here that spends.

## What it can and cannot do

|                                                                        |                                 |
| ---------------------------------------------------------------------- | ------------------------------- |
| Read the authorization record — caps, spend today, revocations, wallet | yes                             |
| Read the spend / x402 / ACP ledgers                                    | yes                             |
| See which accounts share the principal                                 | yes                             |
| **Propose** a spend                                                    | yes                             |
| **Approve** a spend on the user's behalf                               | **no — there is no such tool**  |
| **Execute** a spend                                                    | only within a grant — see below |

`ward_propose_action` does not execute. It queues the request; the main Ward process
delivers it to the user on Telegram or Discord and **replays the request text through
the ordinary graph there**, so it meets the same intent parser, the same gate, the
same caps and the same confirmation as if the user had typed it. Nothing about
arriving via MCP makes a spend cheaper to obtain — the client bought the user's
attention, not their authority.

A leaked token with no grant therefore cannot move money — it can only ask someone
to. A leaked token **with** a grant can spend what that grant allows, until it expires
or is revoked, and every one of those spends is announced to the user immediately.
That is the whole cost of the feature, and it is why grants are opt-in, capped and
short-lived.

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

**2a. Over HTTP** (Phase 16.1), for a client that cannot spawn a local process — and
the way to reach a _deployed_ Ward, since the server is then the running process and
shares its Sibyl Memory by construction:

```
POST https://<WARD_PUBLIC_URL>/mcp
Authorization: Bearer wardmcp_…
```

The endpoint appears only when `WARD_PUBLIC_URL` is set. Missing, malformed, unknown
and revoked tokens all get the same 401 with the same body — telling them apart would
tell a prober which guess was once real.

> ChatGPT connectors expect the MCP OAuth 2.1 authorization framework rather than a
> static bearer, so they are **not** supported yet. Claude Desktop, Cursor and Zed are.

**2b. Over stdio**, for a client on the same machine as the memory. For Claude Code,
`.mcp.json`:

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

## Grants (Phase 16.2)

A token can be given a **scoped execution grant**: capped per action, capped per day,
restricted to an allow-list of action types, expiring, revocable, and issued only from
an authenticated DM. It is Ward's own Spend Permission idea one level up, and it can
only ever _narrow_ what the user may already do — a grant wider than their own caps is
refused, not clamped.

```
/mcp tokens                                  what each token may do
/mcp grants                                  the grants currently live
/mcp grant <token> <actions> <per> <daily> [days]
/mcp confirm <code>                          apply the grant you were just shown
/mcp revoke <token>                          take it back
```

Granting is two steps on purpose: the first reads back, in plain language, what the
token would be able to do _without asking you first_; the second applies it. Every
grant is announced on every other linked account.

**As of Phase 16.2 a grant permits nothing.** The object exists, can be granted,
listed and revoked, and is reported back to the calling token — but no code path
consults it when deciding a spend, and a fully granted token still exposes no tool
that executes. That arrives in 16.3, and the claim above changes with it. See
[`PHASE-16.md`](./PHASE-16.md).

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
