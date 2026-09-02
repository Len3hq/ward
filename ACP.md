# Virtuals ACP — counterparty market

Ward hires another agent to do work a data endpoint can't — "assess this token's
risk" — pays via escrow that settles on Base, and **remembers whether the
counterparty was worth trusting**. The trust write-back (`src/execution/acp.ts`)
is the load-bearing part; the protocol integration is a spike.

## The trust loop (works today, against the stub)

```
hire an agent to assess PEPE
  → preferredCounterparty()            resolve the counterparty
  → trustScore(counterparty)           READ trust BEFORE hiring
  → evaluateGate(acp_job, budget)      same gate as every spend
  → provider.hire(...)                 job: created → escrowed → fulfilled → paid
  → validateExternalData(result)       counterparty output is UNTRUSTED
  → appendSpend(acp_job, …)            one ledger with swap + x402
  → appendAcpJob({ …, trust_delta })   WRITE the outcome
  → next hire reads the re-derived trustScore and narrates it
```

`trust_delta` (`src/acp/trust-delta.ts`) is a **delivery + integrity** signal
(settled? passed validation? substantive?), not a correctness signal — whether the
risk call was right needs hindsight. Pre-seed a hindsight-corrected job for the
demo:

```sh
bun run scripts/seed-acp.ts <telegram_id>
```

## GO / NO-GO for the real path

`ACP_MODE` is `stub` by default. The real path (`ACP_MODE=virtuals`,
`src/acp/virtuals.ts`, `@virtuals-protocol/acp-node-v2`) is **not done** — it is a
spike with a hard go/no-go:

1. `npm i @virtuals-protocol/acp-node-v2`
2. Register the agent at <https://app.virtuals.io/acp/new>; add a signer (Signers
   tab); copy `walletId`, the signer private key, and the `bc-…` builder code.
3. Implement `src/acp/cdp-adapter.ts` — an `IEvmProviderAdapter` over the CDP agent
   spender (`sendCalls` / `signMessage` / `signTypedData` / `getTransactionReceipt`
   / `readContract` / `getLogs`), so escrow reuses the agent spender instead of a
   Privy + Alchemy wallet.
4. Set `ACP_MODE=virtuals` + `ACP_WALLET_ID` / `ACP_SIGNER_KEY` / `ACP_BUILDER_CODE`.
5. Run one job end-to-end: **created → escrowed → fulfilled → paid.**

**If it does not settle:** set `ACP_MODE=stub`, drop the `acp_job` intent from the
demo script, keep the pre-seeded trust history for the memory story. Never fake a
settlement — a non-functioning partner stack is a disqualification condition, and a
judge who catches a fabricated flow distrusts the rest.

## Counterparty disclosure

Prefer hiring an existing, independently-registered Virtuals agent (real two-sided
market). If none offers token-risk assessment, the fallback — a second minimal
agent with its own identity + wallet — **must be disclosed plainly in the README**;
a same-team counterparty presented as external reads as self-dealing.

The stub counterparty is `agent://ward-analyst.stub` and is labelled `[SIMULATED]`
in every result — never shown as a real third party.

## Geoblock

ACP escrow settles on Base through Coinbase infrastructure — the geoblock note in
the [README](./README.md) Troubleshooting section and `src/net.ts` applies here
too.
