# Virtuals ACP — counterparty market

Ward hires another agent to assess a token's risk, pays via escrow that settles on
Base, and **remembers whether the counterparty was worth trusting**. The trust
write-back (`src/execution/acp.ts`) is the load-bearing part; the protocol
integration is a spike.

**What the counterparty actually sells** (don't overclaim it): a normalization and
scoring layer over public token-security data — not an independent audit, and not
analysis a data endpoint couldn't do. It reads GoPlus, applies a deterministic rule
set, and returns a score, a band and the flags that drove them, citing every source
and the sha256 of each response so the result is reproducible rather than trusted.
The judgment is which of ~39 opaque fields matter and how much; the underlying
detection is GoPlus's. See [`counterparty/`](./counterparty/).

That is thin on purpose. What is being demonstrated here is the **trust loop** —
read trust before hiring, validate the output as untrusted, write the outcome back,
let the next hire read it — not the sophistication of the analysis.

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
  → fundAgentFromUser(tgId, budget)        pull from ward-user-<tgId> through
                                           THEIR Spend Permission → CDP spender
  → transferUsdcFromSpender(buyer, …)      forward to the address escrow draws
                                           on (skipped if it IS the spender)
  → session.fund()                         escrow draws on the ACP agent wallet
  → refund buyer → ward-user-<tgId>        escrow releases to the buyer; the
                                           remainder is the user's
```

The middle hop exists because escrow draws on the **registered ACP agent wallet**,
not on Ward's CDP spender — the Virtuals console issues that wallet and the signer
key authorizes signing for it. Without the hop, every job would spend whatever
Ward had parked there. The target is always `agent.getAddress()`, so this stays
correct whichever wallet backs the adapter. The refund leaves from that wallet via
the ACP adapter's `sendTransaction`, since the CDP provider cannot sign for it.

The pull is what makes `appendSpend({ action_type: "acp_job" })` true — without it
the ledger would record a user spend while Ward's float actually paid. No active
Spend Permission is a **hard error**, never a silent fallback to Ward's balance
(`src/wallet/cdp.ts::fundAgentFromUser`).

Gas splits by wallet, and only one of them wants ETH:

| Wallet                                  | Funded with          | By whom  |
| --------------------------------------- | -------------------- | -------- |
| `ward-user-<tgId>` smart account        | **USDC** — job money | the user |
| `ward-agent-spender` (CDP)              | **ETH** for gas      | operator |
| ACP agent wallet (`ACP_WALLET_ADDRESS`) | nothing              | —        |
| counterparty's ACP wallet               | nothing              | —        |

The two ACP wallets are ERC-4337 smart wallets: Base is in the SDK's
`ERC20_SPONSORED_CHAINS` and the adapter routes through an `alchemy-rpc-erc20`
endpoint, so **their gas is paid in USDC by a paymaster**, not from an ETH balance.
Only the CDP spender submits its own transactions and needs ETH.

Neither ACP wallet is a float; each should sit near zero USDC between jobs. A
balance accumulating in either means a refund failed — check `acp_job_history` for
the "owed to user" marker. Because the paymaster takes its USDC from the ACP
wallet, the refund is capped at that wallet's real balance rather than the
arithmetic remainder (`refundFromBuyer`); a shortfall above a cent is reported, a
sub-cent gas difference is not.

The pull lives in `acp/virtuals.ts`, **not** in `execution/acp.ts` — the stub
counterparty is simulated, so a stub-mode hire must move no money at all. There is
a test pinning that (`test/acp.stub.test.ts`).

## GO / NO-GO for the real path

`ACP_MODE` is `stub` by default. The real path (`ACP_MODE=virtuals`,
`src/acp/virtuals.ts`, `@virtuals-protocol/acp-node-v2`) is **not done** — it is a
spike with a hard go/no-go:

1. `npm i @virtuals-protocol/acp-node-v2`
2. Register the agent at <https://app.virtuals.io/acp/new>; on its Wallet tab copy
   the EVM address and the EVM wallet id, then Signers → "+ Add Key" for the signer
   private key. The `bc-…` builder code is optional.
3. Same again for the counterparty ([`counterparty/`](./counterparty/)), with its
   own credentials in `counterparty/.env`.
4. Set `ACP_MODE=virtuals` + `ACP_WALLET_ADDRESS` / `ACP_WALLET_ID` /
   `ACP_SIGNER_KEY`. Fund nothing here — see the table under **Who pays**; the ACP
   wallets are paymaster-sponsored and per-job USDC arrives from the user.
5. Run one job end-to-end: **created → funded → submitted → completed.**

`src/acp/cdp-adapter.ts` is **superseded and unused** — a CDP-backed adapter can't
substitute a different address for the registered agent wallet. `virtuals.ts` uses
the SDK's `PrivyAlchemyEvmProviderAdapter`, the only working built-in
(`ViemProviderAdapter` is an abstract scaffold whose every method throws).

**If it does not settle:** set `ACP_MODE=stub`, drop the `acp_job` intent from the
demo script, keep the pre-seeded trust history for the memory story. Never fake a
settlement — a non-functioning partner stack is a disqualification condition, and a
judge who catches a fabricated flow distrusts the rest.

## Counterparty disclosure

Prefer hiring an existing, independently-registered Virtuals agent (real two-sided
market). If none offers token-risk assessment, the fallback — a second minimal
agent with its own identity + wallet — **must be disclosed plainly in the README**;
a same-team counterparty presented as external reads as self-dealing.

That fallback is built: [`counterparty/`](./counterparty/) — its own registration,
wallet and key, selling one reproducible token-risk report (`counterparty/score.ts`,
a deterministic rule set over GoPlus, with Dexscreener resolving a ticker to a Base
address). Every report states the address it scored, how it got there, and the
sha256 of each source response, so a judge can re-run it instead of trusting it.
The disclosure lives in both [`counterparty/README.md`](./counterparty/README.md)
and the root README. It is written against the installed SDK's `dist/` rather than
its README, which is wrong in two places — see `counterparty/README.md`.

The stub counterparty is `agent://ward-analyst.stub` and is labelled `[SIMULATED]`
in every result — never shown as a real third party.

## Geoblock

ACP escrow settles on Base through Coinbase infrastructure — the geoblock note in
the [README](./README.md) Troubleshooting section and `src/net.ts` applies here
too.
