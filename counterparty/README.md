# Ward's ACP counterparty

**Disclosure, first, because it matters:** this agent is run by the same team as
Ward. It has its own Virtuals ACP registration, its own wallet, and its own
private key, and it settles real escrow with Ward on Base — but it is **not an
independent third party**, and presenting it as one would be self-dealing dressed
up as a market. ACP.md requires this be said plainly wherever the ACP integration
is shown.

It exists because Ward's ACP path needs a counterparty that actually offers
token-risk assessment. If an independently-registered Virtuals agent offers the
same service, prefer hiring that one — `browseAgents("token risk")` will find it,
and the two-sided market story stops needing an asterisk.

## What it sells

One thing: a **reproducible** Base token-risk report.

```json
{
  "subject": "0x…",
  "chain_id": 8453,
  "risk_score": 45,
  "band": "elevated",
  "scale": "0-100, higher is safer",
  "flags": ["mint authority is live", "LP is not locked"],
  "sources": [{ "name": "goplus.token_security", "url": "…", "raw_sha256": "…" }],
  "scorer_version": "1.0.0"
}
```

The value is the **scoring layer**, not the data — `score.ts` is a deterministic,
legible rule set over GoPlus's token-security fields. It is not an audit, and the
report never claims to be one. Every report carries its source URL and the sha256
of the exact response it was derived from, so the work is checkable: re-fetch,
re-run `scoreToken`, get the same number.

`bun test test/counterparty.score.test.ts` (from the repo root) pins the scoring.

## Run it

```sh
cd counterparty
npm i                      # @virtuals-protocol/acp-node-v2
cp .env.example .env       # fill in this agent's OWN credentials
bun run index.ts
```

Its credentials are **its own**, from a second registration at
<https://app.virtuals.io/acp/new> — never Ward's. Ward's live in the repo-root
`.env`; these live here and stay here.

The wallet needs a little ETH on Base for gas. It needs no USDC — it receives.

## Before you trust the event names

The seller-side ACP event names in `index.ts` are **not confirmed against a live
run** — only the buyer-side flow in `src/acp/virtuals.ts` came from the v2 README.
`index.ts` therefore logs every system event it receives. Run it, read the log,
narrow `ACCEPT_EVENTS` / `WORK_EVENTS` to what actually arrives, and only then
call the spike done. A job that hasn't gone created → escrowed → fulfilled → paid
end-to-end has not settled, and per ACP.md the honest move is to fall back to
`ACP_MODE=stub` rather than dress up a partial run.
