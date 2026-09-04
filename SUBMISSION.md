# Submission

## Checklist

- [x] Public repo, real commit history (one commit per build phase)
- [x] `LICENSE` — MIT
- [x] README: what's persisted, where, what's recalled, how each field changes a
      decision — the table in [README.md](./README.md#how-memory-is-load-bearing)
      is grep-findable in under a minute
- [x] Eligibility-gate tests as first-class CI files
      ([`test/deletion-gate.test.ts`](./test/deletion-gate.test.ts) + 3 more),
      running on both memory backends
- [x] Deletion demo scripted: [`DEMO.md`](./DEMO.md) beat 2 +
      [`scripts/demo-deletion.sh`](./scripts/demo-deletion.sh)
- [x] `ATTRIBUTION.md` — the adapted Len3 components by file, Len3hq sign-off noted
- [x] No secrets in history (`.env` git-ignored; only `.env.example` tracked;
      history scanned)
- [ ] 2–5 min demo video with a visible fresh-session recall timestamp — record
      per [DEMO.md](./DEMO.md)
- [ ] Base execution live-verified: `WARD_CDP_TEST=1 bun test test/wallet.cdp.test.ts` + one real x402 payment + one real capped swap on Base Sepolia
- [ ] Virtuals ACP: run the go/no-go spike ([ACP.md](./ACP.md)). If it settles
      end-to-end, keep the ACP beat; if not, `ACP_MODE=stub`, cut the beat, keep
      the pre-seeded trust history
- [ ] Two build-in-public posts (drafts below), tagging Base and Virtuals
- [ ] PMF section — honest, in [README.md](./README.md#product-market-fit); do not
      add numbers

## Two questions for the organizers (before submitting)

1. Does failing the deletion gate zero the _entire_ score, or just the 40-point
   Memory category?
2. Confirm the LICENSE requirement (MIT is in place).

## Submission-form answers

**What is persisted, and where?**
In Sibyl Memory (`sibyl-memory-cli[mcp]`, local SQLite, no vector DB), reached over
the `sibyl-memory-mcp` stdio server:

- `ward.authorization/<telegram_id>` (WARM entity) — `risk_label`, `standing_caps`,
  and four append-only ledgers: `spent_ledger`, `revocation_log`,
  `acp_job_history`, `x402_ledger`.
- `ward.wallet/<telegram_id>` (WARM entity) — smart-account + agent-spender
  addresses, `spend_permission` (`status`, `allowance_usd`, `granted_tx`).
- `ward.conversation.<telegram_id>` (HOT state) — a rolling episodic summary.
- A COLD journal event on every mutation.

Read/write API: [`memory/store.ts`](./memory/store.ts). Tier map + JSON shape:
[`memory/README.md`](./memory/README.md).

**What is recalled across sessions?**
Everything above. A `/newsession` starts a fresh LangGraph thread (empty message
history); the caps, the spent-today total, active revocations, counterparty trust
scores, wallet status, and the conversation summary all come back from Sibyl
Memory. Shown in the demo with a timestamp.

**How does memory change what the agent knows, decides, or does?**
See the table in the README. In short: `read()` missing → refuse every action;
`spent_ledger` sum vs `daily_limit_usd` → block or scale down; `revocation_log`
fresh-read → block a paused action type mid-session; `spend_permission.status`
`"revoked"` → refuse even with the record intact; `trustScore()` from
`acp_job_history` → which counterparty gets hired and how the agent narrates it.
Remove the record and none of this has a basis — the agent refuses, even though the
chain would still permit the spend.

**Partner stacks used (and how):**

- **Base ×1.15** — an on-chain USDC Spend Permission (grant + revoke = contract
  interactions), an x402 payment for premium data, and a capped swap. Three of the
  four qualifying actions, all on one memory-enforced ledger.
- **Virtuals ×1.25** — an ACP job to assess a token's risk; escrow settles on Base;
  the outcome and a trust delta are written back to `acp_job_history` and read
  before the next hire. Stated plainly: the counterparty is a second agent **we
  run** (own registration, wallet and key — not an independent third party), and
  what it sells is a normalization + scoring layer over public token-security data
  with cited sources and a reproducible score, not an independent audit. The trust
  write-back is the contribution; the analysis is deliberately thin.

## Build-in-public post drafts

**Post 1 — Base**

> Built Ward for the @sibyllabs hackathon: a Telegram crypto agent whose memory is
> the authorization layer. It can't exceed the per-action / daily limits you set
> once — and those caps are mirrored on-chain as a revocable USDC Spend Permission
> on @base. Every spend (x402 data, capped swap) goes on one ledger the agent
> enforces against `min(memory cap, on-chain allowance)`. Revoke the permission
> on-chain → it can't spend, mid-session. Delete the memory → it refuses entirely.
> #BuildOnBase

**Post 2 — Virtuals**

> Ward doesn't just pay APIs — it hires other agents. When it needs analysis a data
> endpoint can't give, it posts a job on @virtuals_io ACP, pays via escrow (settles
> on Base), validates the result, and **remembers whether that counterparty was
> worth trusting.** The next hire reads the accumulated trust score first. Memory
> as a reputation layer for agent-to-agent commerce. #Virtuals #ACP

## PMF — honest

No waitlist, no usage numbers. The validated pain point is public: crypto users
will not hand an autonomous agent unrestricted spend authority. Ward's wedge is a
memory-scoped, on-chain-revocable authorization layer where the caps are the
user's and the agent's own policy can only be stricter. If real evidence
(conversations with traders, a landing-page signup) doesn't exist by submission,
this section stays modest — a fabricated claim is a disqualification condition,
including post-payout.
