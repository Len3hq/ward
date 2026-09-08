# Phase 17 — Self-serve memory deletion, from any channel

_Goal: every user can delete their own authorization record — the deletion the
eligibility gate tests — from Telegram or Discord, without an operator running a
script._

Today the deletion gate is real but only an operator can pull it: `scripts/forget-auth.ts`
over `railway ssh`. The property the hackathon judges ("delete the memory and the
agent has no basis for authority") is asserted in CI and demoable, but a *user* who
wants it has no way to ask. Phase 17 closes that — the same delete, moved to a slash
command, with the same fail-closed result on every channel.

**Scope: the authorization record only.** No wallet deletion, no identity removal, no
data-erasure tier. `/forget_me` removes `ward.authorization/<id>` (and the episodic
conversation summary), and nothing else. Everything else the user might want gone —
the wallet, channel links — is either recoverable by re-onboarding or an operator
task, and neither belongs in this phase.

---

## 1. Why this is safe to expose

Handing users a "delete my authorization" button on a money-moving agent sounds like
the opposite of safe. It is safe here for the same three reasons `/mcp_grant` is:

- **It only ever removes authority.** Like `revoke`, and unlike `grant`, there is no
  version of this command that lets Ward do *more*. The worst outcome of a spurious
  `/forget_me` is that Ward refuses to act until the user re-onboards — which is 30
  seconds and restores the same wallet (§4).
- **It cannot be triggered by injected text.** It is a slash command, read straight
  off the command text and routed **outside the graph** — exactly like `/link` and
  `/unlink`. No tool result, fetched document, or model output can call it. A test
  asserts this by code path, as `test/identity.linking.test.ts` already does for
  link codes.
- **It is two steps, principal-bound.** `/forget_me` reads back precisely what will
  be deleted and returns a single-use confirmation code; a second message applies it.
  The code is digest-keyed HOT state with a 5-minute TTL, burnt on use, and unusable
  by any other principal — the same machinery as `/mcp_grant` → `/mcp_confirm`.

And one reason it is safer than the operator script: **it announces itself.** Like a
link or a grant, the deletion is broadcast to every other linked account, so a
hijacked Telegram session cannot quietly wipe a user's policy without their Discord
lighting up.

**MCP is excluded.** `/forget_me` refuses when `channel === "mcp"`, identically to
`/link mcp`-mint and `/mcp grant`: a bearer token from a config file is a process,
not a person, and must not be able to delete a Ward.

---

## 2. What it deletes

```
/forget_me            → readback + confirmation code
/forget_me <code>      → apply it
```

A bare `/forget_me` proposes; a 6-character code applies. This mirrors `/link` (no
argument mints, an argument redeems) so there is no new command shape to learn.

| Entity | `/forget_me` |
| --- | --- |
| `ward.authorization/<id>` (caps + all four ledgers) | **forgotten** |
| `ward.conversation.<id>` (episodic summary) | **forgotten** |
| `ward.wallet/<id>` (addresses, spend permission) | kept |
| `ward.identity` / `ward.accounts` (channel links) | kept |
| `ward.mcp_grant` / MCP tokens / `ward.owner` | kept |
| COLD journal (`ward.*` events) | kept — audit trail |
| On-chain USDC Spend Permission | untouched (fail-closed: `read()` → `null` → every spend path refuses anyway) |

This is exactly what `deletion-gate.test.ts` checks, now self-serve. It clears the
conversation summary too, because "delete my memory" that leaves last week's spend
narrative in the system prompt is not what anyone means — and the gate test only
asserts the *authorization* entity is gone, so clearing more does not weaken it.

The wallet record survives on purpose (§4). Deleting the on-chain Spend Permission is
a separate action the user already has — `revoke my permission` — and is not coupled
into this command: a memory operation should not depend on a gas transaction that can
fail or hang.

---

## 3. The running session after a delete

The current chat thread still holds its message history in `MemorySaver` after
`/forget_me`. That is fine:

- `intentNode` re-reads memory every turn and routes to `refuse` when `read()` is
  `null` — the deletion takes effect on the very next message, mid-session.
- The `/forget_me` reply tells the user to `/newsession` (or just re-onboard), so the
  transcript does not carry stale context forward.
- The conversation summary is already gone, so a `/newsession` after `/forget_me`
  starts genuinely empty.

---

## 4. Why the wallet survives — and re-onboarding restores it

`CdpWalletProvider` derives its CDP account names from `ward.wallet.account_key`
(`ward-user-<account_key>`), and `account_key` is **pinned, never rewritten** — the
smart-account address is a pure function of that string
([memory/README.md](./memory/README.md), [src/wallet/cdp.ts](./src/wallet/cdp.ts)).

`/forget_me` keeps `ward.identity` / `ward.accounts`, so the `WardUserId` is stable
across the deletion. Re-onboard (`set me up`) → a fresh `ward.authorization` →
`generate my wallet` → a new `ward.wallet` written with `account_key` = the same
`WardUserId` → the **same** CDP account name → the **same** smart-account address.
Funds and any still-live Spend Permission are exactly where they were.

The one thing that *would* strand funds is deleting `ward.identity` too: the next
message would mint a fresh `WardUserId`, a fresh `account_key`, and a different
address. That is why `/forget_me` does not remove channel links, and why "erase my
identity entirely" stays a documented operator task, not a slash command.

---

## 5. Sub-phases

### 17.1 — The command

- New `CommandBase` value `"forget"`. It is not an identity command (link / mcp /
  unlink / whoami), so either widen the registration predicate in
  `src/telegram/gateway.ts` / the Discord gateway to `isIdentityCommand(spec.base)
  || spec.base === "forget"`, or rename that predicate to `isSlashOnlyCommand`.
  Keep the "argument off the command text only" discipline — this is the security
  property, not a style choice.
- `src/identity/forget.ts` — `forgetMeCommand(ctx: CommandContext, argument: string)`:
  - empty argument → readback + `proposeForget(userId, channel)`
  - a code → `confirmForget(code, userId, channel)`
  - `channel === "mcp"` → refuse
- `memory/forget.ts` (or extend `src/mcp/grants.ts`'s pending-code helpers):
  `proposeForget` / `confirmForget`, reusing `writeLinkCode` / `readLinkCode` under a
  `ward-forget:<code>` digest namespace, `CONFIRM_TTL_MS`, burn-before-delete,
  `pending.ward_user_id !== userId` → the same opaque "I don't know that code".
- `confirmForget`:
  1. append a COLD journal event `authorization_forgotten` (`{ channel }`) **before**
     the delete, so the audit trail records the deletion itself;
  2. `backend().forgetEntity("ward.authorization", userId)`;
  3. `forgetConversation(userId)` — add it to `store.ts` next to `writeConversation`
     (`backend().forgetEntity("ward.conversation." + userId, …)`);
  4. announce to `otherAccounts(userId, channel, accountId)` via `notifyAccount`,
     best-effort like `announceLink` — report unreached channels, never unwind a
     completed delete.
- Command table row: `{ name: "forget_me", base: "forget", description: "Delete your
  authorization from Sibyl Memory — Ward stops acting until you re-onboard", menu:
  BOTH }`. Under 100 chars for Discord. No `hint` — the command is complete on its
  own, like `/mcp_stop`.
- `/help` gains a line under "taking things away". `/whoami`'s closing line already
  says "All of them share one authorization record" — append "Delete it with
  /forget_me."
- Optional (open question 3): a `consumeMintAllowance`-style rate window so a
  compromised account can't spam the other channels with deletion announcements.

**Journal kind:** `authorization_forgotten`.

### 17.2 — Docs + demo, same commit as 17.1

- [DEMO.md](./DEMO.md) **Beat 2** becomes stronger: the deletion is now done *by the
  user, on camera, in Telegram* — `/forget_me` → `/forget_me <code>` → the same
  refusal — instead of cutting to a terminal. `scripts/forget-auth.ts` stays as the
  operator/CI tool and the script the judges can run themselves.
- [README.md](./README.md) load-bearing table: the `ward.authorization/<id>` row's
  "Deleted →" cell gains "(user-triggerable: `/forget_me`)". Add a short "Deleting
  your data" section.
- [SIBYL-MEMORY.md](./SIBYL-MEMORY.md) "The deletion gate" section: note the gate is
  now reachable from chat, not only `memory_forget` via the script.
- [MULTI-CHANNEL.md](./MULTI-CHANNEL.md): `/forget_me` is channel-agnostic policy in
  `src/identity/` like `/unlink`; Discord reuses it verbatim.
- [MCP.md](./MCP.md): add `/forget_me` to the list of commands an MCP client cannot
  run.

---

## 6. Tests

`test/forget-me.test.ts` (new), driving the real command through a `FakeAdapter` /
`CommandContext` as `test/identity.linking.test.ts` does:

| Assertion |
| --- |
| `/forget_me` → code → `/forget_me <code>` → `read(userId)` is `null` and the next `swap` request is **refused with the no-authorization message, no wallet call** (the `deletion-gate.test.ts` assertion, via the command) |
| after the delete, `readWallet(userId)` is unchanged; re-`initialize` succeeds and a fresh `generate wallet` yields the **same** `account_key` / address |
| wrong code, expired code, and a code minted in another principal's DM are all rejected with the same opaque message |
| an injected `/forget_me <code>` inside conversation prose never reaches `confirmForget` — routed as unhandled, and the real code still works afterward (the link-code injection test, adapted) |
| `channel === "mcp"` → refused |
| the conversation summary is `null` after the delete |
| a COLD `authorization_forgotten` event exists after the delete (audit trail survives) |

Extend `test/identity.cross-channel.test.ts`: `/forget_me` confirmed on Telegram →
Discord refuses the next action **and** the Discord account received the deletion
announcement. This is the operator-script deletion-gate case, now proven through the
user-facing path.

Live backend: add a `/forget_me` case to `test/memory.sibyl-mcp.test.ts` (opt-in,
`SIBYL_MEMORY_MCP_TEST=1`) — confirm `memory_forget` on an archived-then-recreated
entity round-trips, since re-onboarding after `/forget_me` depends on
`memory_remember` succeeding over a name Sibyl has archived.

---

## 7. Threat model

| | Before | After 17 |
| --- | --- | --- |
| Injected "/forget_me" in a tool result / document | n/a (no command) | **no effect** — slash-only, outside the graph, two-step |
| Hijacked Telegram session runs `/forget_me` | operator-only, so n/a | user re-onboards (30s, same wallet); **every other linked account is notified** at deletion time |
| Leaked MCP token runs `/forget_me` | n/a | **refused** — human channels only |
| Confirmation code phished into another principal's DM | n/a | principal-bound (`ward_user_id !== userId` → opaque reject), 5-minute TTL, single use |

The worst spurious outcome is a refusing agent, not a moved dollar. That asymmetry
is why this is a button and `grant` is not.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| A second delete path drifts from `scripts/forget-auth.ts` | Both call the same `backend().forgetEntity("ward.authorization", …)`; the command is the script's body with a confirm code and an announcement around it |
| Re-onboarding fails because Sibyl archived the entity name | 17.1 adds the live-backend round-trip test before the feature is announced; `forget-auth.ts` + the demo already re-onboard, so the path is exercised |
| Stale in-thread message history after a delete confuses the next turn | `intentNode` already re-reads memory per turn and routes to `refuse` when `read()` is `null`; the `/forget_me` reply tells the user to `/newsession` |
| Confirmation code phished into another principal's DM | Principal-bound, 5-minute TTL, single use — identical to `/mcp_confirm` |
| Announcement doesn't reach an account | Best-effort like `announceLink`: report unreached channels to the user, never unwind a completed delete |

---

## 9. Open questions

1. **Should `/forget_me` also clear the COLD journal?** Current answer: no — it is
   the audit trail of the user's own actions and deletions, it is never read onto the
   critical path or into a prompt, and keeping it means "when did I delete my Ward?"
   is answerable.
2. **One confirmation code, or a typed phrase ("delete my ward")?** A code matches
   every other confirm flow in Ward and is copy-paste on mobile; a typed phrase is
   more legible but a new pattern. Leaning code.
3. **Rate-limit `/forget_me`?** Low value — it only destroys the caller's own data
   and re-onboarding is free — but a `consumeMintAllowance`-style window costs
   nothing and stops a compromised account from spamming the other channels with
   deletion announcements. Include it.
