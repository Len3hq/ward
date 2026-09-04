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

## Who pays

An ACP job is **the user's spend, from the user's wallet** — the same money path
as a swap or an x402 purchase, not a Ward-funded perk:

```
evaluateGate(acp_job, budget)              memory cap ∧ on-chain allowance
  → fundAgentFromUser(tgId, budget)        pull the budget from ward-user-<tgId>
                                           through THEIR Spend Permission
  → session.fund()                         escrow draws on the agent spender
  → refundUser(tgId, budget − settled)     escrow releases to the buyer (the
                                           spender); the remainder is the user's
```

The pull is what makes `appendSpend({ action_type: "acp_job" })` true — without it
the ledger would record a user spend while Ward's float actually paid. No active
Spend Permission is a **hard error**, never a silent fallback to Ward's balance
(`src/wallet/cdp.ts::fundAgentFromUser`).

Two things stay Ward-side, by design:

- **Gas.** The agent spender submits every transaction, so ETH on Base is an
  operator cost that scales with usage — users never touch it.
- **Nothing else.** The spender is a conduit, not a float; it should hold no
  meaningful USDC of its own.

The pull lives in `acp/virtuals.ts`, **not** in `execution/acp.ts` — the stub
counterparty is simulated, so a stub-mode hire must move no money at all. There is
a test pinning that (`test/acp.stub.test.ts`).

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
