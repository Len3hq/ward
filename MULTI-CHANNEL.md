# Ward across channels — Telegram, Discord, MCP

How one Ward user stays one Ward user when they arrive from three different places,
and how the authorization record in Sibyl Memory keeps meaning the same thing on all
of them.

Companion to `Ward-Build-Phases-and-Len3-Infra-Map.md`. Phases continue that
document's numbering (Phases 0–8 are done; this is 9–13).

---

## 1. The honest answer first: the agent does not "recognise" you

There is no signal in a conversation that proves a Discord account and a Telegram
account are the same person. Writing style, wallet mentions, self-declared names,
timing correlation — every one of them is an **impersonation vector**, not an identity
proof. An agent that moves money must never infer identity from content.

So Ward does not recognise you across channels. Ward is **told**, exactly once, by a
proof you can only produce if you already control the first account — and from then on
it performs a table lookup, not a judgement.

Three mechanisms were considered:

| Mechanism                                                                                                                      | Proof it provides                                                          | Verdict                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **One-time link code** — Ward mints a short-lived secret inside the already-authenticated Telegram DM; you paste it in Discord | Possession of the code proves control of the Telegram account at mint time | **Adopted (Phase 10)**                                                                                   |
| **Wallet signature** — sign a nonce with the smart account already in `ward.wallet`                                            | Strongest: binds to the thing that actually holds the funds                | **Deferred (Phase 14)** — needs a browser sign-in page, already out of scope per the build plan          |
| **Email OTP / OAuth**                                                                                                          | Binds to an external IdP                                                   | **Rejected** — drags back the JWT / `PlatformLink` / session machinery deliberately stripped out of Len3 |

The link code is the standard answer and it is sound, provided four properties hold —
all four are requirements, not nice-to-haves:

1. **Minted only in an authenticated context.** The code appears solely in the DM of the
   channel account that already owns the record. Seeing it is the proof.
2. **Single-use and short-lived.** 5-minute TTL, burned on first redemption, rate-limited
   to N mints per user per hour.
3. **Confirmed back on the origin channel.** After a successful link, Ward messages the
   _original_ channel: _"A Discord account `@foo` (id 4…9) just linked to your Ward.
   If this wasn't you, send /unlink discord now."_ This is the phishing backstop — a
   social-engineered code still surfaces to the real owner.
4. **Never accepted from untrusted text.** The link code is a slash-command argument
   only. It must never be parseable out of agent conversation, tool output, or fetched
   external data — otherwise a prompt injection can link an attacker's account. Route it
   before `screenUserInput`, never through the LLM.

Everything else in this document assumes the link has already happened.

---

## 2. What identity looks like after the change

### Today

```
Telegram id 700100200
        │
        └──► entity name, verbatim
             ward.authorization / 700100200
             ward.wallet        / 700100200
             state ward.conversation.700100200
```

Identity, channel account, and storage key are the same string. That is why a second
channel cannot be added without a substrate change.

### After Phase 9

```
  tg:700100200 ─┐
                │                    ward.identity/<channel>:<account>
disc:5512...41 ─┼──► resolveUser() ──►  { ward_user_id, channel, linked_at }
                │                                    │
 mcp:tok_9f3a. ─┘                                    ▼
                                            ward_01J9XQ4M7B…  (opaque, stable)
                                                     │
                        ┌────────────────────────────┼───────────────────────┐
                        ▼                            ▼                       ▼
              ward.authorization/<id>       ward.wallet/<id>    ward.conversation.<id>
                 caps · ledgers ·             smart account ·      rolling episodic
                 revocations · trust          spend permission        summary
```

Two new concepts:

- **`WardUserId`** — an opaque, channel-free principal (`ward_` + ULID). Generated once,
  at first contact on whichever channel came first. **This becomes the Sibyl Memory
  entity name.** It never encodes a channel, so "which channel was primary" is never
  baked into storage.
- **`ward.identity`** — a WARM entity per _channel account_, category `ward.identity`,
  name `<channel>:<account_id>`, body
  `{ ward_user_id, channel, account_id, linked_at, linked_via }`. This is the lookup
  index. It lives in the same store as everything else — no new infrastructure, works on
  both the `sibyl-mcp` and `fs` backends, and every link/unlink lands in the COLD journal
  like any other mutation.

Resolution is one entity read: `ward.identity/discord:551234...` → `ward_user_id` →
everything else. Cache it per process behind the existing `withLock` discipline.

### Why the collision matters more than it looks

`normalizeTgId` at [`memory/store.ts:49`](memory/store.ts) enforces `/^\d+$/`. Discord
snowflakes are 17–19 digit integers. They **pass that regex**. Without namespacing,
a Discord user is not rejected — they are silently routed onto whatever
`ward.authorization/<that number>` happens to hold. Low probability, unbounded
consequence: it is the authorization record for money movement. The channel prefix in
`ward.identity` names, and the opaque non-numeric `WardUserId`, both exist to make that
class of bug unrepresentable.

---

## 3. Channels are not equal — confirmation tiers

The project's thesis is that the memory record is the authorization substrate and a
human confirmation is a human act. A third surface tests that directly, because **an
MCP stdio client has no user identity at all** — it is a local process holding a token.

So each channel carries a tier, and the tier decides what a turn may do:

| Channel      | Principal is proven by                | Read memory | Propose spend | Confirm spend                       |
| ------------ | ------------------------------------- | ----------- | ------------- | ----------------------------------- |
| **Telegram** | Telegram account (DM)                 | yes         | yes           | yes                                 |
| **Discord**  | Discord account (DM), linked via code | yes         | yes           | yes                                 |
| **MCP**      | a bearer token in the client config   | yes         | yes           | **no — bounced to a human channel** |

An MCP client can ask "what am I authorized for?", can read the ledger, and can _propose_
a swap — but the confirmation interrupt is delivered to the user's primary human channel
and must be answered there. A leaked MCP token therefore cannot move money on its own.
This is not a limitation to apologise for; it is the same argument the deletion gate
makes, extended to a surface where the caller cannot be a person.

---

## 4. What crosses channels, and what does not

The split matters, and most of it falls out for free once the entity name is the
`WardUserId`.

**Shared across every channel** (all keyed by `WardUserId`):

- the authorization record — caps, `spent_ledger`, `revocation_log`, `acp_job_history`,
  `x402_ledger`
- the wallet record and its on-chain spend permission
- the rolling episodic summary, `ward.conversation.<id>` — so "you told me you're
  conservative" surfaces in Discord although it was said on Telegram, with no extra work
- derived trust scores, since they are re-derived from the shared history on every read

**Per-channel, deliberately:**

- the LangGraph thread and its `MemorySaver` checkpoint (`thread_id` becomes
  `<channel>:<chat>:<seq>`). A Discord conversation should not replay Telegram's raw
  message history — different rendering, different chat, different scrollback.
- `/newsession` scope — resets the channel you're in
- a pending confirmation. **You answer where you were asked.** A confirm raised on
  Telegram is not answerable from Discord; the second channel is told a confirmation is
  pending elsewhere.

Three consequences are worth turning into tests and demo beats, because each one is the
project's thesis holding under a new stress:

1. **The daily cap is one cap.** Spend $8 on Telegram, ask on Discord, get told $2
   remains. A user cannot get 2× their limit by opening a second app.
2. **Revocation is instant everywhere.** `isRevoked` already re-reads fresh on every
   action. Revoke on Discord → the next Telegram turn refuses.
3. **The deletion gate crosses channels.** Delete the entity and _both_ surfaces refuse,
   including the MCP one. The gate gets stronger, not weaker, with more surfaces.

---

## 5. Build phases

### Phase 9 — Identity substrate (no new channel) — **DONE**

The boring, load-bearing phase. It ships alone so the diff is reviewable and Telegram
is provably unchanged.

- `src/identity/` — `WardUserId` type + ULID mint; `resolveUser(channel, accountId)`
  (read `ward.identity`, create principal + link on first contact); `linkAccount`,
  `unlinkAccount`, `accountsFor(userId)`.
- `memory/store.ts` — `normalizeTgId` → `normalizeUserId`, accepting `ward_<ulid>`.
  Every `tgId` parameter becomes `userId`. Public API shape is otherwise unchanged.
- `memory/schema.ts` — `wardIdentitySchema`; `journalEventSchema.tg_id` → `user_id`
  plus a `channel` field. Safe to change: journal events are append-only and the gate
  never reads them back (all gate reads come off the WARM entity body).
- `src/agent/state.ts` — `tgId` → `userId`, plus `channel` and `channelAccountId`.
  Nodes pass it through; no node logic changes.
- `scripts/migrate-identity.ts` — one-shot. For each legacy `ward.authorization/<digits>`:
  mint a `WardUserId`, write `ward.identity/telegram:<digits>`, copy authorization +
  wallet + conversation to the new key, `forgetEntity` the old one, journal the move.
  Sibyl Memory has no rename, so migration is read → put → forget, and must be idempotent.
- `scripts/forget-auth.ts` — accept either a channel account (`telegram:700100200`) or a
  `WardUserId`, resolving the former. The judges' deletion command must keep working.

**Done when:** the full existing suite passes with only the rename applied, and the
migration script round-trips a seeded legacy record.

#### What actually shipped

Everything above, plus one thing this plan got wrong, and two small additions.

**The plan missed that the wallet address is derived from the identity string.**
`CdpWalletProvider` names its CDP accounts `ward-user-<id>` / `ward-owner-<id>`, so
the user's smart-account address is a _function_ of whatever id it is handed.
Rekeying identity would therefore have silently pointed every migrated user at a
fresh, empty smart account, stranding their funds and their granted spend permission
at the old address — a data-loss bug that no rename-only test would have caught.

The fix: `ward.wallet` gained a required `account_key`, minted once at connect and
never rewritten, and the wallet provider's parameter was renamed `tgId` → `accountKey`
rather than → `userId`, because it is not a principal and never was. New users get
`account_key = <WardUserId>`; migrated users keep their **original Telegram id**. The
ACP provider's `hire()` takes the same key (nullable — the stub tolerates no wallet,
the Virtuals path refuses, since escrow funded from anywhere but the user's own Spend
Permission would be Ward's float).

Two additions:

- `ward.accounts` / `<ward_user_id>` — a reverse index. Neither backend can list or
  query entities, so "which accounts does this principal own?" needed its own
  document; it is written in the same lock as the forward entry.
- `src/identity/ulid.ts` — a 30-line Crockford base32 ULID, no dependency.

Journal events carry `user_id` + a nullable `channel`: a spend is written below the
gateway and genuinely does not know which surface it came from, while identity events
always do. Threading the channel through spends is a Phase 11 concern, when there is
more than one to distinguish.

**Result:** 137 pass / 8 skip / 0 fail on the `fs` backend (baseline at HEAD was
117 / 8 / 0 — the delta is 19 new identity tests plus a bare-integer collision guard),
and 141 pass / 4 skip / 0 fail against the live `sibyl-memory-mcp` server, which
confirms the changed journal wire body. Lint, typecheck and format green.

### Phase 10 — The linking flow — **DONE**

- `src/identity/linking.ts` — `mintLinkCode(userId, ttl)` → high-entropy short code
  (`WARD-XXXX-XXXX`, unambiguous alphabet, no 0/O/1/I); `redeemLinkCode(code, channel,
accountId)`. Codes in Sibyl HOT state (`ward.linkcode.<hash>`) so a restart doesn't
  drop them — store a hash, never the code itself.
- Guarantees: 5-min TTL · single use · burn-on-redeem · rate limit (3 mints/user/hour,
  5 redeem attempts/account/hour) · constant-time compare · **origin-channel
  notification on success**.
- Commands, channel-agnostic: `/link` (mint), `/link <code>` (redeem), `/unlink
<channel>`, `/whoami` (list linked accounts + which is primary).
- Refuse to redeem a code into an account that already resolves to a _different_
  principal — that is a merge, and merging two authorization records with two ledgers is
  not a thing Ward should do silently. Tell the user to unlink first.
- Parse link commands **before** the guard/agent path. A code must never be reachable
  from LLM output or external data.

**Done when:** a Telegram-onboarded user redeems a code on a second channel stub and
`read(userId)` returns the same record from both; expired, reused, and cross-principal
codes are each rejected with a distinct test.

#### What actually shipped

All of the above, plus one case this plan didn't think through.

**"Refuse a cross-principal redeem" was too blunt.** The ordinary path for a new
Discord user is to say "hi" _before_ linking — which mints a principal for that
account. Refusing every cross-principal redeem would have made that user permanently
unlinkable: `/unlink` refuses to remove a principal's last account, so there was no
way out of the state the flow itself creates.

So the refusal is now conditioned on whether the sitting principal holds anything.
No authorization record and no wallet means it is an empty shell, and rebinding loses
nothing — `redeemLinkCode` detaches it (via the store's `forgetIdentity`, not
`unlink`, whose last-account guard is exactly wrong here), journals the release, and
links. The moment that principal has a record or a wallet, redeeming is refused
outright, because merging would combine two spend ledgers and two revocation logs.
`RedeemResult.rebound` reports which happened, and both are tested.

Two details worth keeping:

- **The code is never stored.** The HOT-state key _is_ its sha256, so what lands in
  Sibyl Memory cannot be replayed by someone reading the store. Keying by digest is
  also what disposes of the constant-time-compare requirement in the plan: there is
  no secret comparison to make constant-time, because nothing is ever compared — a
  miss is an absent document.
- **Burn before link.** A crash between the two costs the user a code they can mint
  again; the other order would leave a live code that had already worked.

Codes are `WARD-XXXX-XXXX` over a 30-character alphabet with no `0/O`, `1/I/L` or
`U` — chosen for transcription between two screens, not density. `randomInt` is
rejection-sampled, so a 30-character alphabet stays uniform where `randomBytes % 30`
would not.

`src/identity/notify.ts` is a small notifier registry so the announcement can cross
gateways — the Discord gateway redeeming has no handle on the Telegram one. Delivery
is best-effort and never unwinds a completed link, but a failure is reported to the
redeemer rather than passing silently, so an undelivered announcement is visible to
somebody. Phase 11 folds this into `ChannelAdapter.notify`.

**Result:** 161 pass / 8 skip / 0 fail on `fs`, 165 / 4 / 0 against live
`sibyl-memory-mcp`. `test/identity.linking.test.ts` adds 24, including the injection
case — a code embedded in prose is rejected as malformed and, importantly, is _still
redeemable afterwards_, so a failed injection doesn't burn a real user's code.

### Phase 11 — Channel abstraction + Discord gateway — **DONE**

The existing Telegraf gateway holds real logic worth not duplicating: graph streaming,
throttled edits, interrupt detection, yes/no resolution, message splitting.

- `src/gateway/core.ts` — extract `runTurn()`: owns `graph.stream`, the
  `__interrupt__` branch, and `refreshSummary`. Channel-free.
- `src/gateway/adapter.ts` — `ChannelAdapter`: `{ channel, limit, render(md), send, edit,
askConfirm, notify }`.
- `src/telegram/gateway.ts` — refit onto the adapter. Telegram keeps HTML rendering,
  4096 limit, throttled edits, yes/no regex. **The existing Telegram tests staying green
  is the proof the abstraction is right** — do this before writing any Discord code.
- `src/discord/gateway.ts` — `discord.js` v14. Differences that are not cosmetic:
  - **2000-char limit**, not 4096 → `splitMessage` becomes a parameter, not a constant.
  - Discord renders markdown natively → the render step is identity, `mdToHtml` is not
    used. (Which is why rendering belongs on the adapter.)
  - **Buttons for confirmations** via `interactionCreate` — strictly better than yes/no
    regex. Encode the pending intent id in `custom_id` and **validate
    `interaction.user.id` against the principal that raised the interrupt**, so a button
    is not clickable by a bystander.
  - **DM-only.** Refuse in guild channels with "DM me" — money movement and confirmation
    prompts do not belong in a shared channel, and it sidesteps the privileged
    `MessageContent` intent.
- `src/index.ts` — start whichever gateways have tokens configured; neither is required.

**Done when:** Telegram tests unchanged and green; a Discord adapter test drives the same
`runTurn` through onboarding, a confirm, and a refusal.

#### What actually shipped

The order held: Telegram was refitted onto the adapter first and its suite stayed at
161 green before a line of Discord was written, which is what proved the abstraction
rather than merely asserting it.

**The confirmation shape drove the interface.** The plan listed `askConfirm` beside
`send` and `edit` as if it were another output method, but the two channels answer a
confirmation in fundamentally different ways — Telegram waits for the _next message_
matched against a yes/no regex, Discord waits for an _interaction event_ on a button.
Rather than leak that into `runTurn`, `askConfirm(text)` blocks and returns
`Promise<boolean | null>`. Telegram implements it with a pending resolver the text
handler settles; Discord awaits a component collector. `runTurn` just does
`await adapter.askConfirm(...)` and resumes the graph, which is why it stayed
channel-free. That works because a LangGraph `interrupt()` has already ended the run —
resuming is a fresh `invoke`, so blocking costs nothing.

`null` is the third answer, and it is load-bearing: a confirmation that was never
answered is a **refusal**. It says so rather than leaving a silent pending action the
user might assume went through, and there is a test for it.

Discord specifics that are not cosmetic: 2000 characters (so `splitMessage` takes the
limit from the adapter), native markdown (so the render step is identity and
`mdToHtml` has no analogue), buttons with an explicit `interaction.user.id` check, and
DM-only. DM-only pays for itself twice — a confirmation naming someone's daily cap
doesn't belong in a shared channel, _and_ Discord exempts DMs from the privileged
Message Content intent, so the bot asks only for `Guilds` + `DirectMessages`.
`Partials.Channel` is required or DM events never fire at all; both of those are
asserted by test, because each fails silently.

`src/index.ts` now starts whichever gateways have tokens, and `loadConfig` fails only
when neither is set.

**Result:** 176 pass / 8 skip / 0 fail on `fs`, 180 / 4 / 0 against live
`sibyl-memory-mcp`. `gateway.channel.test.ts` drives `runTurn` through a fake adapter
(onboarding, approve, decline, unanswered, refusal) and asserts the cross-channel
property directly: Telegram spends $8 of a $10 cap, Discord is refused the next $20.

### Phase 12 — MCP server surface — **DONE**

Ward stops only consuming MCP and starts serving it. `@modelcontextprotocol/sdk` is
already a dependency.

- `src/mcp/server.ts` — `Server` + `StdioServerTransport`.
- Principal binding: `WARD_USER_TOKEN` in the client's MCP config, minted by `/link
mcp` on a human channel, stored hashed as a `ward.identity/mcp:<token_hash>` link.
  No token → every tool returns "not linked" with mint instructions.
- Tools — read-mostly by design:
  `ward_whoami` · `ward_read_authorization` · `ward_recent_activity` ·
  `ward_link_status` · `ward_propose_action`.
- `ward_propose_action` records the proposal, pushes the confirmation to the primary
  human channel, and returns a pending id. **There is no `ward_execute` tool.**
- Everything the server returns about stored content passes through
  `validateExternalData` on the way out, same as any other untrusted string.

**Done when:** an MCP client reads the live authorization record; a proposal surfaces as
a Telegram confirmation; a deleted record makes every tool refuse.

#### What actually shipped

All three, plus the piece this plan skipped over entirely.

**"Push the confirmation to the primary human channel" has no in-process route.** The
MCP server runs as its _own process_ — stdio, spawned by whatever client is using it —
so the notifier registry from Phase 10 is empty there. It cannot reach a running
gateway at all. Written naively, `ward_propose_action` would have silently done
nothing, and the "surfaces as a Telegram confirmation" criterion would have quietly
failed.

So a proposal is queued in Sibyl Memory (`ward.proposals`) and drained by
`src/gateway/proposals.ts` inside the main process. Delivery is deliberately **not a
notification**: the request text is replayed through the ordinary graph on the user's
own channel, so it meets the same intent parser, the same gate, the same caps and the
same confirmation as a typed message. A test asserts exactly that — a proposal made
with $95 of a $100 daily cap already spent is refused on delivery. The MCP route buys
attention, never authority.

That in turn needed gateways reachable without a `ctx`, so Phase 10's notifier
registry became `src/gateway/channels.ts` — a `ChannelPort` with both `notify` and
`adapterFor(accountId)` — and the Telegram adapter was rebuilt on `Telegram` + a chat
id rather than a Telegraf `Context`. It now serves both the user who just messaged and
one being pushed to.

Three smaller decisions:

- **`/unlink mcp` revokes every token**, not just the newest (`unlinkAll`). Chat
  accounts are unlinked one at a time; a credential is not, and a forgotten second
  token surviving a revoke is exactly the failure that matters.
- **Neither the token nor its digest is ever echoed back** to the client that
  presented it — the digest is as good as the credential for lookup.
- `ward_recent_activity` wraps its output in `<untrusted_data>`: ledger rows carry
  counterparty-supplied text, which is data and never instruction.

The queue is written by one process and drained by another, and the in-process lock
cannot span them. That race is documented in `memory/store.ts` and `MCP.md` rather
than papered over: proposals arrive at human speed, and a lost one is a missing
notification, not an unauthorised spend.

**Result:** 193 pass / 8 skip / 0 fail on `fs`, 197 / 4 / 0 against live
`sibyl-memory-mcp`. `test/mcp.server.test.ts` adds 17, including a test that asserts
the tool list contains nothing matching `execute|swap|pay|send|transfer|approve`, and
one that an ignored proposal moves nothing — silence is never approval. Operator setup
is in `MCP.md`.

### Phase 13 — Cross-channel proofs + docs — **DONE**

- `test/identity.cross-channel.test.ts` — the three properties from §4: shared daily cap,
  cross-channel revocation, cross-channel deletion gate (all three surfaces).
- `test/identity.linking.test.ts` — TTL, reuse, cross-principal, rate limit, injection
  (a link code embedded in agent output must not link).
- `README.md` — extend the "How memory is load-bearing" table with a channel column;
  document that the record is per-_user_, not per-_account_.
- `DEMO.md` — new beat: spend on Telegram, ask on Discord, watch the shared cap answer.
  It is the strongest single demonstration that memory, not the chat surface, is the
  authorization substrate.
- `ATTRIBUTION.md` — note this re-adapts Len3's `PlatformLink` / `resolve-user` concept,
  which the original build plan deliberately stripped (§ line 40, 66). Same idea, no
  JWTs, keyed into Sibyl Memory instead of Postgres.

#### What actually shipped

All of it, plus a documentation bug that would have broken the demo on camera.

`test/identity.cross-channel.test.ts` drives the **real** surfaces — `runTurn` through
a channel adapter for Telegram and Discord, and a live MCP client over an in-memory
transport — rather than asserting against the store directly. Nine tests across the
three properties, each also a demo beat. A fourth fell out while writing them and was
worth keeping: **identity survives deletion.** Delete the authorization and the user
is still known on every channel and refused on every channel, because identity and
authority are separate entities and only one of them was deleted.

**`bun run scripts/seed-acp.ts telegram:<id>` was documented but did not work.** The
demo seeds _before_ the user has ever messaged the bot, so there is no identity to
resolve yet and `resolveRef` returned null. Fixed in the script rather than the docs,
since seeding first is the right order: given a channel reference it now does exactly
what a first message would — mint a principal and link the account — and says so.
`forget-auth.ts` deliberately still refuses to create, because you cannot delete what
was never there.

A third copy of the same fake channel adapter was about to appear, so it moved to
`test/support.ts` as `FakeAdapter` + `turnOn`, and the two existing suites were
refitted onto it.

Docs: the README's load-bearing table now says the record is keyed by a Ward _user_
and carries a four-row cross-channel proof table; `DEMO.md` gains **Beat 5b**, which
links Discord live on camera and is refused on the cap Telegram already spent;
`ATTRIBUTION.md` credits the re-adapted `PlatformLink` concept and the one-turn-loop
gateway shape, and lists `discord.js` and the MCP SDK's second role as a _server_.

Secret sweep re-run after adding the bearer-token system: clean.

**Result:** 202 pass / 8 skip / 0 fail on `fs`, 206 / 4 / 0 against live
`sibyl-memory-mcp`.

### Phase 14 — Wallet-signature linking — **DONE** (spec corrected)

**The spec as written was not sound, and building it verbatim would have shipped
security theatre.** It said: sign a nonce with the smart account in `ward.wallet`.
But that smart account and its owner are both **CDP-managed** — Ward can produce a
valid signature from that address at any time, for anybody. A signature from it
proves nothing about the human in front of the browser.

So what is proved instead is control of an address the **user** holds, in their own
wallet, which is a real credential precisely because Ward cannot produce it. The
address is an identity, never a source of funds: Ward's money stays in the CDP smart
account and still moves only inside the Spend Permission.

**Why it is worth having.** A link code can only be minted from a chat account you
still control. Lose the Telegram account and there is no route back — the
authorization record is intact and unreachable. `ward.owner/<address>` resolves a
principal from a signature alone, so a verified wallet is a _recovery_ path. That is
the whole phase; everything else is consequence.

- **`/link wallet`** mints a state and returns a page URL. The page connects a
  wallet, signs `challenge(state)`, and POSTs `{address, signature}` back. Verified
  with viem's `verifyMessage` — EOA / EIP-191. Contract wallets (EIP-1271) would
  need an RPC round trip and are not covered.
- **The state is inside the signed message**, so a signature cannot be replayed
  against a different link.
- **A failed signature does not burn the state.** A fumbled wallet prompt should cost
  nothing, so the state is read, the signature checked, and only then spent.
- **Trust on first use, with a ceiling worth stating.** The first address a principal
  proves is enrolled, on the strength of the DM the state was minted in — the same
  assumption the link code rests on. After that a signature must match an address
  already on file, so a stranger cannot quietly become a second owner. This is
  exactly as strong as the DM it was set up from and no stronger: it does not upgrade
  a compromised chat account into a secure one.
- **Recovery goes through the same merge rule.** `canClaim` / `claimAccount` were
  split out of the code path for this: an empty shell principal is rebound, a funded
  one is refused. Two ways in, one rule.
- **Every account on the record is told**, because a recovery credential enrolled
  silently is precisely the attack. `/unlink wallet <address>` drops one; `/whoami`
  lists them separately from accounts, since a wallet is a way _back to_ Ward and not
  a way to talk to it.

Storage mirrors identity exactly — forward `ward.owner/<address>` → principal,
reverse `ward.owners/<userId>`, forward written last — because neither backend can
list or query, and because a half-written owner should leave an address unresolved
rather than resolving to a half-built record.

Tests use real keys and real signatures (`test/identity.wallet.test.ts`): stubbing
`verifyMessage` would be testing nothing. They cover enrollment, a wrong challenge, a
mismatched key, garbage input, the second-wallet refusal, both recovery outcomes, the
single-use and expiry rules, the no-burn-on-failure rule, and revocation.

**Unproven until it meets a real wallet:** the browser half. `window.ethereum` and
`personal_sign` are exercised by no test here — only what the server does with what
they produce.

### Phase 15.1 — Frictionless Discord onboarding — **DONE**

Phases 9-13 made the _authorization_ cross channels correctly. They did not make
**arriving** on a second channel pleasant: joining from Discord was five steps, one of
which was an invisible trap.

The comparison that prompted this was Len3, which links Discord in one click —
`web/components/dashboard/ChatAppLinking.tsx` builds an OAuth2 URL with
`scope=identify applications.commands` and `integration_type=1` (user install, so
there is no server to invite a bot to), and `discord_gateway.py::_send_welcome_dm`
then has the bot open the DM itself. That needs an HTTP surface Ward does not have;
Phase 15.2 is where it would come from. 15.1 is everything that does **not** need one.

**The trap, and why it deserved a phase.** `resolveUser` mints a principal on first
contact. So a Discord account that simply said "hi" became a _second_ Ward — and the
punishment arrived one step later, when `/link` refused its code, because moving a
principal that already holds an authorization record is a silent ledger merge
(Phase 10's rule, and the right one). The mistake and the error were in different
places, which is what made it invisible.

- **Nothing is minted until the account says which it is.** An unknown Discord
  account gets a first-contact prompt offering the two real options — link an
  existing Ward, or `set me up` for a new one — and `resolveExisting` (not
  `resolveUser`) is what decides. The opt-in phrase is matched by `OPT_IN`, so
  ordinary conversation cannot start an accidental second Ward. Stateless: any
  non-opt-in message from an unknown account gets the prompt again.
- **Registered slash commands.** `SLASH_COMMANDS` is set on `ClientReady`, so
  Discord's client autocompletes `/link` instead of matching nothing and fighting
  the user. Registration is **best-effort and must stay that way** — the typed-text
  path is the guaranteed one, and a missing `applications.commands` scope or a
  propagation delay must not take the gateway down. Both front doors run through one
  `runCommand`, so a link code is still read from a command argument and nowhere
  else.
- **This keeps Ward off the privileged Message Content intent.** Len3 requires it;
  Ward does not, because interactions are not message content and Discord exempts
  DMs. Do not trade that away for convenience.
- **A minted code now ships with the door as well as the key.** `registerDmLink`
  records where each running gateway can be reached — Discord from `ClientReady`,
  Telegram from the `getMe` that `src/index.ts` already pays for — and `/link` lists
  every channel _except_ the one it was minted on. Only running channels register,
  so the reply is never a link to a bot that isn't there.

Five steps become three, and the trap is gone. Tests: first-contact opt-in matching
and the slash-command payload in `test/discord.gateway.test.ts`; the deep-link reply
(and its omissions) in `test/identity.linking.test.ts`.

### Phase 15.2 — OAuth2 identify + user install — **DONE**

The rest of the Len3 mechanism. Discord returns the account id itself, so nothing is
transcribed, and `integration_type=1` installs the app to the **user** — there is no
server to invite a bot to, and it is what makes the welcome DM deliverable.

**`/link discord` on Telegram** hands back one URL. Open it, authorize, and Ward DMs
you on Discord already knowing your caps.

**The `state` is a link code wearing different clothes.** This was the design call
worth making carefully: an OAuth state is a nonce bound to one principal, single-use,
short-lived — which is precisely `linking.ts`. So `mintLinkState` / `redeemLinkState`
reuse the same storage, the same 5-minute TTL, the same mint and redeem rate limits,
and — critically — the same `redeemHashed` core, so the rebind-or-refuse rule that
protects two funded principals from being merged has exactly one implementation.
What differs is only what a human does with it: nobody transcribes a state, so it is
256 bits of URL-safe base64 rather than eight readable characters. Separate hash
namespaces (`ward-link:` vs `ward-oauth:`) mean a state can never be typed in as a
code, or the reverse — asserted by test.

**What the HTTP surface is not.** `src/http/server.ts` has three routes: a redirect,
a callback, and `/healthz`. There is no read route and no write route. The only state
it can change is "this Discord account belongs to that principal", and only on
presentation of a state Ward minted, inside an authenticated DM, less than five
minutes earlier. It starts **only** when `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
and `WARD_PUBLIC_URL` are all set; without them Ward serves no HTTP at all and the
code flow is the only route.

Three rules the callback follows, each for a reason:

- **Render, never redirect onward.** A 302 would leak the state in a `Referer`, and
  the state is the credential until it is burnt.
- **Announce anyway.** An account linked in a browser needs the phishing backstop
  _more_ than one that typed a code, not less — the same `announceLink` runs, so
  every other account still hears about it and `/unlink discord` is still one message
  away.
- **`no-store` on every response**, so a shared browser cannot show the next person a
  page naming someone's Ward.

**Operator setup:** Developer Portal → OAuth2 → register redirect
`<WARD_PUBLIC_URL>/link/discord/callback`; generate a Railway domain; set the three
variables. `PORT` is injected by Railway.

**Still unproven, and it is the one thing that matters:** whether the bot can open a
DM to someone who user-installed the app but shares no guild. Len3 ships
`_send_welcome_dm` immediately after OAuth so it works there, but Len3's bot may also
share a guild with the user. If it turns out not to work, the link itself is still
correct and complete — only the welcome DM is lost, and the user opens the DM
themselves as in 15.1. Nothing else in the phase depends on it.

**This unblocks Phase 14.** Wallet-signature linking was deferred for want of a
browser page. There is now a server to hang one on.

Two claims that changed with this phase, stated rather than glossed: the README's
"no backend" becomes _one process, no database, one public callback_, and an OAuth
client secret joins the threat model.

### Phase 15.3 — Symmetry: one click in both directions — **DONE**

15.2 made _arriving on Discord_ one click. Arriving on **Telegram** was still a code,
which left the flow lopsided: a user who starts on Discord — the one most likely to
be new — got the worse half.

**Telegram needs no OAuth and no server.** A `t.me/<bot>?start=<state>` deep link
delivers the state to `bot.start` as a payload, so the whole 15.2 round trip
collapses into a URL. The payload is a link `state` with every property a code has —
single use, five minutes, rate limited — and, like a code, it arrives as a command
argument and never from model output, so the injection rule from Phase 10 still
holds. Telegram caps a start payload at 64 characters; a 32-byte state is 43 in
base64url, which is asserted by test rather than assumed.

**The command layer no longer knows how any of it works.** `registerStartLink`
takes a builder per channel, registered by whatever actually knows the URL — the
Telegram username after `getMe`, the Discord one when the callback server starts. So
`/link <channel>` is one code path for both, `mintDiscordLink` is gone, and an
unregistered channel falls back to a code instead of offering a link that goes
nowhere. Adding WhatsApp later means registering a builder, not editing `linkCommand`.

The asymmetry that remains is real and worth stating: Discord's route needs an OAuth
app, a client secret and a public URL, while Telegram's needs nothing at all. That is
a fact about the two platforms, not a gap in Ward.

Both `/help` texts and the Discord slash-command description now lead with
`/link <channel>` and offer the code as the fallback, which is the right order — the
code path is what you use when one-click isn't configured, not the default.

`DEMO.md` Beat 5b is rewritten around the tap: authorize, the page says **Linked**,
and cutting to Discord the DM is already waiting. It keeps the code flow as a
documented fallback for a machine where OAuth isn't configured, so the beat can
always be shot.

---

## 6. Risks

| Risk                                                                                                                                  | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord snowflakes pass the `^\d+$` telegram-id regex and alias onto a real record                                                    | Opaque non-numeric `WardUserId`; channel-prefixed `ward.identity` names; regex tightened in Phase 9                                                                               |
| Migration is not idempotent → duplicate principals or a half-copied record                                                            | Migration writes the link entity **last**; re-running finds it and no-ops; journal every move                                                                                     |
| Social-engineered link code                                                                                                           | Short TTL + single use + rate limit + **origin-channel notification** so the real owner always sees it                                                                            |
| Prompt injection links an attacker's account                                                                                          | Link codes parsed only as slash-command arguments, before the guard, never from LLM or fetched content                                                                            |
| A pending confirmation is answered on the wrong channel, or lost on restart                                                           | Confirmations are channel-local by design; persist the pending intent so a restart doesn't strand it                                                                              |
| Discord buttons clicked by a bystander                                                                                                | DM-only, plus explicit `interaction.user.id` check against the raising principal                                                                                                  |
| An unknown Discord account is minted a second principal just by talking, then refused its link code                                   | Phase 15.1: nothing is minted until the account opts in; `resolveExisting` decides, not `resolveUser`                                                                             |
| Slash-command registration fails and takes the gateway with it                                                                        | Registration is best-effort and caught; the typed-text path is the guaranteed one                                                                                                 |
| The OAuth callback becomes a way in                                                                                                   | Three routes, none of which read or write anything but one link; state is single-use, 5-minute, rate-limited, hash-stored; the server does not start unless explicitly configured |
| A stolen one-click URL links an attacker's Discord                                                                                    | Same backstop as a stolen code — `announceLink` still fires on every other account, and a state burns on first use                                                                |
| A verified wallet becomes a way to spend                                                                                              | It is an identity credential only — no code path reads `ward.owner` when deciding a spend; money still moves solely within the Spend Permission and the memory caps               |
| A wallet is enrolled on someone's Ward without their knowledge                                                                        | Enrollment only from a state minted in an authenticated DM, only when the principal has no owner yet, and every linked account is notified                                        |
| A leaked MCP token moves money                                                                                                        | MCP cannot confirm — every spend bounces to a human channel                                                                                                                       |
| 176 `tgId` references across 27 files make Phase 9 a large mechanical diff                                                            | Phase 9 ships alone, rename-only, with the existing suite as the regression proof — **done**, 117→137 tests, none lost                                                            |
| Rekeying identity changes the derived CDP account name, so a migrated user's smart-account address moves and their funds are stranded | `ward.wallet.account_key` is pinned at connect and preserved verbatim by migration; the provider takes an `accountKey`, never a principal — **found and fixed in Phase 9**        |
