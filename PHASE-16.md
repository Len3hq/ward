# Phase 16 — Remote MCP, and execution within a grant

_Goal: a user connects **their own** LLM client — ChatGPT, Claude, Cursor — to their
Ward, and it can act inside the rules they already set, against the smart account
they already funded._

This is the first phase that adds authority rather than surface, so it opens with the
argument for why that is safe rather than with the build steps.

---

## 1. The tension, stated plainly

Ward currently claims, in `README.md`, `MCP.md` and a test that greps the tool list:

> `ward_propose_action` does not execute. A leaked token cannot move money. It can
> only ask someone to.

Phase 16 changes that. Anyone reading the repo will notice, so the honest framing
matters more than the feature.

**Why the rule existed.** Telegram and Discord authenticate a _person_: a DM is
already proof of who is on the other end. An MCP client authenticates a _process_
holding a bearer token from a config file. There is nobody on the other end of the
pipe to ask, so there was no sound way to treat its request as consent.

**Why it can change.** The problem was never "MCP". It was that the client had no
authority the user had ever granted it. That is a solvable problem, and Ward already
solved the identical one at the layer below: the agent may spend the user's USDC
because the user granted a **capped, expiring, revocable on-chain Spend Permission**
scoped to exactly what they meant.

Phase 16 applies Ward's own idea one level up. An MCP client may execute because the
user granted it a **capped, expiring, revocable execution grant**, from an
authenticated DM, scoped to exactly what they meant.

**The invariant that must survive.** Authority still originates in something the user
said in an authenticated context, and it still lives in Sibyl Memory. Delete the
record and every path — Telegram, Discord, MCP — refuses. Nothing here is a new
source of authority; it is a narrower delegation of an existing one.

**What we are giving up, said out loud.** Today a leaked MCP token is worthless. After
Phase 16 a leaked token is worth _at most the grant its owner attached to it_ — capped
per action, capped per day, scoped to specific action types, expiring, revocable, and
announced on every human channel the moment it spends. That is a real reduction in
safety and it should be priced as one. It is defensible only because the ceiling is
set by the user, is smaller than their own caps, and is visible.

**Default stays propose-only.** A token with no grant behaves exactly as it does now.
Execution is opt-in, per token, per action type.

---

## 2. The model: three limits, not two

Ward's centrepiece becomes one term longer:

```
executable = min(grant remaining, memory cap remaining, on-chain allowance remaining)
```

Each is set by a different act of the user, and any one of them going to zero stops
the spend:

| Limit              | Set by                              | Revoked by                           |
| ------------------ | ----------------------------------- | ------------------------------------ |
| Grant              | `/mcp grant` in an authenticated DM | `/mcp revoke`, expiry, `/unlink mcp` |
| Memory cap         | onboarding                          | re-onboarding, deleting the record   |
| On-chain allowance | `grant a $N daily permission`       | `revoke my permission` (on-chain)    |

The grant is always the innermost. It can never widen the other two, and
`evaluateGate` remains the single place the comparison happens — the grant enters as
one more input, not as a second gate.

### The grant object

A new WARM entity, `ward.mcp_grant/<token_hash>` — keyed by the **token's hash**, not
by the principal, so a user can hold one read-only token and one narrowly executing
token at the same time, and revoke either without touching the other.

```jsonc
{
  "ward_user_id": "ward_01K…",
  "token_hash": "<sha256>", // the key; never the token
  "action_types": ["x402_data_purchase"], // subset of SPEND_ACTIONS
  "per_action_limit_usd": 0.5,
  "daily_limit_usd": 2,
  "expires_at": "2026-09-13T00:00:00Z", // required; no perpetual grants
  "granted_at": "2026-09-06T12:00:00Z",
  "granted_on": "telegram",
  "spent_today_usd": 0, // derived from the ledger, not stored authoritatively
  "revoked_at": null,
}
```

Deliberate choices:

- **Expiry is required.** A grant that never ends is a key, and the whole point is
  that this is not a key. Cap it at 30 days.
- **Action types are an allow-list, not a deny-list.** `x402_data_purchase` for
  cent-scale data is a very different risk from `swap`; defaulting to "all" would be
  the wrong shape.
- **`spent_today_usd` is derived** from `spent_ledger` entries tagged with this token
  hash, exactly as `spentToday()` already derives the user's own number. Two
  authorities, one ledger — the same principle that made swap, x402 and ACP share a
  cap.
- **Keyed by token hash** so revoking a grant and revoking a token are separate acts.

---

## 3. Sub-phases

Each is shippable and testable alone. **16.1 adds no authority at all** and is worth
doing first regardless of whether the rest ever ships.

### 16.1 — Remote transport (read + propose only) — **DONE**

Serve the existing five tools over HTTP so a client that cannot spawn a local process
can connect. No new tools, no new authority.

- `@modelcontextprotocol/sdk` 1.30 ships
  `WebStandardStreamableHTTPServerTransport`, which takes a `Request` and returns a
  `Response` — it drops into the `Bun.serve` from Phase 15.2 with no Express and no
  second listener.
- Route: `POST /mcp` (plus the transport's `GET`/`DELETE` for streaming and session
  teardown). Stateless mode (`sessionIdGenerator: undefined`) unless a client needs
  resumability.
- Auth: `Authorization: Bearer wardmcp_…`, resolved by the sha256 lookup that already
  exists in `src/mcp/token.ts`. No new credential type.
- **This is the first public route that reads user data**, so it needs what the
  linking routes did not: a per-token rate limit, `no-store`, no CORS by default, and
  a refusal that does not distinguish "unknown token" from "revoked token".
- The stdio entrypoint stays. Local clients keep working unchanged.

**As built.** A fresh `McpServer` and transport per request, in stateless mode, bound
to that request's bearer token and closed in a `finally` — a session outliving its
request would hold one caller's credential and serve another. Missing, malformed,
unknown and revoked tokens all get the same 401 with the same body, asserted byte for
byte, so the endpoint never tells a prober which guess was once real. 60 requests per
token per minute, `no-store` on every response, no CORS. Tests drive a real `Client`
over a real `StreamableHTTPClientTransport` against a real `Bun.serve`.

**Fixes the constraint we hit while testing:** the MCP server must share Sibyl Memory
with the running Ward. Over HTTP it _is_ the running Ward, so `railway ssh` stops
being the only way in.

**ChatGPT caveat, unresolved.** ChatGPT connectors expect the MCP authorization
framework (OAuth 2.1 with discovery), not a static bearer. The SDK ships
`server/auth/` for this. Decide in 16.1 whether to implement OAuth or accept that
16.1 unlocks Claude/Cursor/Zed remotely and ChatGPT waits for 16.5. **Do not assume a
bearer token is enough for ChatGPT — verify before promising it.**

### 16.2 — Grants (no execution yet) — **DONE**

The authority object, and the commands that create it, with nothing yet consuming it.

- Schema + store: `ward.mcp_grant/<hash>`, mirroring the identity indexes
  (forward/reverse, forward written last).
- `/mcp grant` — an authenticated-DM flow, not a one-liner: it should read back what
  it is about to allow in plain language and require a confirmation, because this is
  the one command in Ward that hands out spending authority.
- `/mcp grants` lists them; `/mcp revoke <id>` removes one; `/unlink mcp` continues to
  revoke everything.
- `ward_read_authorization` reports the calling token's grant, so a model can see its
  own ceiling and not propose things it cannot do.
- Journal kinds: `mcp_grant`, `mcp_grant_revoked`.

Shipping this alone is safe by construction: nothing reads the grant yet.

**As built.** `ward.mcp_grant/<token_hash>` + `ward.mcp_grants/<user>`, forward
written last, and revocation **forgets** the forward entry rather than marking it —
an execution check that reads a missing document fails closed, where one that reads a
document and has to notice a field is one `if` away from failing open.

Granting is two deliberate steps. `/mcp grant <token> <actions> <per-action> <daily>
[days]` reads back in plain language what the token would be able to do _without
asking you first_, and returns a single-use code; `/mcp confirm <code>` applies it.
The pending grant reuses the link-code storage — digest-keyed, 5-minute TTL, burnt on
use — so a code shown in one principal's DM is unusable by another, and "I typed a
command I didn't understand" is not enough to arm a client.

Three checks are worth naming. A grant wider than the user's own caps is **refused
rather than clamped**: it would not be dangerous, since `min()` still applies, but the
readback would promise headroom that does not exist. The check runs **again at
confirmation**, because the user may have tightened their caps in between and a
readback is not a reservation. And `spent_today` is **derived** from `spent_ledger`
entries tagged `via_token`, exactly as `spentToday()` derives the user's own number —
two authorities reading one ledger, so a grant can never disagree with the record
about what happened. The tag is on the schema now and stays null until 16.3 writes it.

`ward_read_authorization` tells a calling token its own ceiling, so a model stops
proposing what it could never do. Every grant is announced to every other linked
account, because this is the moment a client stopped needing to ask.

A test asserts the point of the phase: **a fully granted token still exposes no tool
matching `execute|swap|pay|send|transfer|approve`.**

### 16.3 — Execution — **DONE**

- `ward_execute_action`, present **only when the calling token has a live grant** —
  absent from `listTools` otherwise, so a client without a grant sees exactly today's
  surface.
- It must reuse the existing path, not reimplement it: `parseIntent` →
  `evaluateGate` (with the grant as an extra limit) → the same provider calls the
  `execute` node makes → `appendSpend` with the token hash → `appendX402` /
  `appendAcpJob`. **A second implementation of the gate is the failure mode to fear
  most here.** Prefer driving the real graph node over copying it.
- Re-read memory and re-run the gate immediately before the provider call, exactly as
  `execute` does today, so a revocation in the gap still blocks.
- Idempotency key from the request, as `confirmedIntent` already does, so a retrying
  client cannot double-spend.
- **Every execution is announced** on every linked human channel, with the amount, the
  action, the token that did it and how to revoke. This is not a nicety: it is the
  only way a user notices a token misbehaving, and it is the same backstop as the
  link announcement.

**As built, and the decisions taken.**

Execution covers **whatever the grant allows**, `swap` and `acp_job` included — chosen
deliberately over an x402-only first cut, so the grant object means what it says. The
mitigations that remain are the ones that were also chosen: caps, expiry, `min()`, and
an announcement on every single spend.

`execution/perform.ts` was extracted from the graph's `execute` node, which is now a
thin wrapper mapping state in and an `AIMessage` out. **Both surfaces run the same
fresh reads, the same `evaluateGate`, the same provider and the same ledger writes** —
the whole suite passing unchanged after the extraction is the regression proof. The
grant enters `evaluateGate` as a third ceiling rather than a second gate, and its
refusals name _the grant_ rather than the user's cap, because "over what you allowed
this client" and "over your own limit" send someone to change different things.

`ward_execute_action` returns a **receipt id immediately** and settles in the
background; `ward_receipt` polls it. Settlement can outlast a client timeout, and a
retry that does arrive is absorbed by the idempotency key. Receipts are scoped to the
token that created them — a second token on the same principal cannot read them.

Both tools are **registered conditionally**, per request over HTTP and at startup over
stdio. An ungranted client therefore sees exactly the pre-16.3 surface, and the
project's oldest claim — that the tool list contains nothing that can spend — stays
literally true for every token nobody granted anything. A test asserts both halves.

`/mcp grant` now refuses without an active on-chain Spend Permission: granting
execution authority when the chain cannot pay promises something that cannot happen.

Twelve tests in `test/mcp.execute.test.ts`, weighted toward refusals: an action type
outside the grant, no grant at all, a revoked grant, over the per-action limit, over
the grant's daily limit while still inside the user's own, and the user's own
revocation blocking a granted client.

### 16.4 — Observability, kill switch, docs — **DONE**

- `ward_recent_activity` distinguishes what the user did from what a token did.
- `/whoami` shows grants alongside accounts and wallets.
- One command that stops everything from MCP at once, independent of unlinking.
- `MCP.md` rewritten: the "no execute tool" claim becomes "no execute tool **without a
  grant**", with the grant model explained. `README.md`'s load-bearing table gains the
  grant row. Every place the old claim appears must change in the same commit — a
  stale "MCP cannot spend" line is worse than no documentation.
- `DEMO.md`: a beat where a leaked-token scenario is bounded by the grant.

**As built.** `ward_recent_activity` labels every spend `by you`, `by this client` or
`by client <ref>` — one ledger with several authorities writing to it is only
auditable if each row says which. `/whoami` lists granted clients under the heading
**"MCP clients that can spend WITHOUT asking you"**, because that is the sentence
someone needs to see when they go looking for what can reach their Ward.

`/mcp stop` is the kill switch, and it is deliberately **not** `/unlink mcp`: it
revokes every grant while leaving the tokens able to read and propose. That is the
thing you want when you are not yet sure whether anything is actually wrong, and
destroying credentials is a decision you can still take afterwards.

`DEMO.md` gains **Beat 5c**: grant a client ten cents and a day, watch it buy data
with nobody confirming, watch the next call get refused by the grant rather than by
the user's cap, then `/mcp stop`. The line it lands: the client never had authority of
its own — it had a loan of yours, bounded by your caps and your on-chain allowance,
and it ended when you said so.

The README's load-bearing table gains the `ward.mcp_grant/<token_hash>` row, so the
one document that claims to list everything memory decides now lists this too.

## 7. What is left

**16.5 — OAuth 2.1, if ChatGPT is wanted.** Everything above works with a bearer
token, which Claude Desktop, Cursor and Zed accept. ChatGPT connectors expect the MCP
authorization framework. The SDK ships `server/auth/` for it. **Verify against a real
connector before promising it** — that assumption has not been tested.

**A guard against tests reaching live CDP.** `bun test` sets `NODE_ENV=test`, and
`walletProvider()` currently returns the real CDP provider whenever the keys are in
the environment — which they are, because `config.ts` loads `.env`. A test that
forgets `test/support.ts`'s hermetic setup therefore transacts against the **shared
production agent spender**, since `AGENT_SPENDER_NAME` is a constant. Refusing the CDP
provider under `NODE_ENV=test` unless `WARD_CDP_TEST=1` turns a convention into an
impossibility.

---

## 4. Threat model, before and after

|                                                     | Today                                  | After 16.3                                                                    |
| --------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Leaked token, no grant                              | can read and propose                   | **unchanged** — can read and propose                                          |
| Leaked token, with grant                            | n/a                                    | can spend up to the grant, then nothing; every spend announced                |
| Compromised LLM / prompt injection in a tool result | can propose; user sees it and declines | can spend within the grant **without asking** — this is the real new exposure |
| Ward's memory deleted                               | everything refuses                     | everything refuses                                                            |
| On-chain permission revoked                         | nothing can spend                      | nothing can spend                                                             |
| Grant expired                                       | n/a                                    | falls back to propose-only                                                    |

The middle row is the one to design against. Mitigations, all of which belong in
16.3: keep default grants small and scoped to `x402_data_purchase`; require an
explicit, confirmed act to include `swap`; announce every execution; expire
everything; and make `/mcp revoke` reachable in one message.

An honest statement for the README: _a leaked MCP token can spend only what you
explicitly gave that token, only until it expires, and never quietly._

---

## 5. Risks

| Risk                                                                    | Mitigation                                                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| The gate is reimplemented in the MCP path and drifts from the chat path | Execution drives the same `evaluateGate` and the same provider calls; a test asserts both surfaces refuse identically at the same cap |
| A public HTTP endpoint that can move money                              | Bearer over TLS, hash lookup, per-token rate limit, no CORS, grant required, everything announced and journaled                       |
| The docs keep claiming MCP cannot spend                                 | Every occurrence changes in the same commit as 16.3; a test greps for the stale claim                                                 |
| A grant outlives the user's intent                                      | Expiry required, capped at 30 days, listed by `/whoami`, revocable in one message                                                     |
| Retrying client double-spends                                           | Idempotency key on the confirmed intent, as the chat path already does                                                                |
| ChatGPT still cannot connect after 16.1                                 | Verify the auth requirement **before** promising it; OAuth is a separate sub-phase, not an afterthought                               |

---

## 6. Open questions to settle before building

1. **OAuth or bearer?** Decides whether ChatGPT is in scope for 16.1 or 16.5. Verify
   against a real ChatGPT connector rather than documentation.
2. **Should a grant require the on-chain allowance to already exist?** Arguably yes:
   granting execution authority to a client when no Spend Permission exists is
   promising something that cannot happen.
3. **Per-token or per-client-name grants?** Per-token is simpler and matches the
   existing credential model; revisit only if users hold many.
4. **Does `ward_execute_action` block until settlement, or return a receipt id?**
   Settlement can take tens of seconds; a blocking call may exceed client timeouts.
5. **Multi-tenancy.** Everything above assumes one Ward per deployment, which is what
   exists today. A hosted Ward serving many users over one HTTP endpoint is a larger
   change than this phase, and should not be smuggled into it.
