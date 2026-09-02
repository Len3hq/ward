# Wallet & Spend Permissions

Ward's authorization has two limits:

```
executable = min(memory cap remaining, on-chain allowance remaining)
```

- **Memory cap** — the agent's own policy layer in Sibyl Memory (per-action limit,
  daily limit, revocations). Can only be _stricter_.
- **On-chain Spend Permission** — the hard outer bound the user controls directly.
  A USDC Spend Permission on Base from the user's smart account to the agent
  spender, revocable on-chain at any time.

Delete the Sibyl Memory record and the agent has no policy → it refuses, even
though the chain would still permit a spend.

## Provider

`src/wallet/` — a `WalletProvider` behind two implementations, selected at load:

|                      | When                                                                  | Path                                                                           |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `CdpWalletProvider`  | `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` + `CDP_WALLET_SECRET` all set | **judged** — `src/wallet/cdp.ts`                                               |
| `StubWalletProvider` | otherwise                                                             | tests / no-key dev — deterministic fake addresses + in-memory permission state |

The provider is pure infra — it never touches Sibyl Memory. The `wallet` graph
node calls it, then persists to the `ward.wallet` entity via `writeWallet`.

## CDP setup

```sh
# https://portal.cdp.coinbase.com/projects/api-keys
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
CDP_WALLET_SECRET=...
BASE_NETWORK=base-sepolia   # or "base"
```

Accounts are CDP **named** accounts, so they're idempotent:

- agent spender — one CDP Server Account, `ward-agent-spender`
- user smart account — `ward-user-<tgId>`, owned by `ward-owner-<tgId>`, with
  `enableSpendPermissions: true`

Custody framing (state it plainly, don't overclaim): this is hackathon-scoped
managed-MPC custody via Coinbase CDP plus a revocable on-chain Spend Permission —
non-custodial in spirit, **not** an audited production custody stack. For a real
Embedded Wallet (user holds their own key shares) a browser sign-in page is
needed; out of scope for the bot.

Coinbase geoblocks some regions — see [`src/net.ts`](./src/net.ts) and the
Troubleshooting section of the [README](./README.md).

## Chat flow

```
connect my wallet            → creates the smart account + spender, writes ward.wallet
grant a $100 daily permission → on-chain Spend Permission, ward.wallet.spend_permission = active
swap $40 usdc for eth        → confirmation cites "on-chain allowance $X remaining"
revoke my permission         → on-chain revoke + pauses every spend action in memory
pause swaps                   → memory-only revocation of one action type
```

`connect_wallet` / `grant_permission` / `revoke` are deterministic (the `wallet`
node), not LLM tool calls — they work without `OPENAI_API_KEY`.

## Verify live

The CDP field names in `src/wallet/cdp.ts` (`listSpendPermissions` shape,
`waitForUserOperation` params, token-balance shape) are from the SDK's type
declarations. Confirm against a live project once:

```sh
WARD_CDP_TEST=1 BASE_NETWORK=base-sepolia bun test test/wallet.cdp.test.ts
```

If a call breaks, fix only `src/wallet/cdp.ts` — nothing else depends on the CDP
surface.
