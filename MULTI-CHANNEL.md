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

### Phase 13 — Cross-channel proofs + docs

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

### Phase 14 — Deferred: wallet-signature linking

Replace (or add alongside) the code with a signed nonce from the smart account in
`ward.wallet`. Strongest binding available, because it binds identity to the thing that
holds the funds rather than to a chat account. Blocked on the browser sign-in page that
Phase 4 already deferred.

---

## 6. Risks

| Risk                                                                                                                                  | Mitigation                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord snowflakes pass the `^\d+$` telegram-id regex and alias onto a real record                                                    | Opaque non-numeric `WardUserId`; channel-prefixed `ward.identity` names; regex tightened in Phase 9                                                                        |
| Migration is not idempotent → duplicate principals or a half-copied record                                                            | Migration writes the link entity **last**; re-running finds it and no-ops; journal every move                                                                              |
| Social-engineered link code                                                                                                           | Short TTL + single use + rate limit + **origin-channel notification** so the real owner always sees it                                                                     |
| Prompt injection links an attacker's account                                                                                          | Link codes parsed only as slash-command arguments, before the guard, never from LLM or fetched content                                                                     |
| A pending confirmation is answered on the wrong channel, or lost on restart                                                           | Confirmations are channel-local by design; persist the pending intent so a restart doesn't strand it                                                                       |
| Discord buttons clicked by a bystander                                                                                                | DM-only, plus explicit `interaction.user.id` check against the raising principal                                                                                           |
| A leaked MCP token moves money                                                                                                        | MCP cannot confirm — every spend bounces to a human channel                                                                                                                |
| 176 `tgId` references across 27 files make Phase 9 a large mechanical diff                                                            | Phase 9 ships alone, rename-only, with the existing suite as the regression proof — **done**, 117→137 tests, none lost                                                     |
| Rekeying identity changes the derived CDP account name, so a migrated user's smart-account address moves and their funds are stranded | `ward.wallet.account_key` is pinned at connect and preserved verbatim by migration; the provider takes an `accountKey`, never a principal — **found and fixed in Phase 9** |
