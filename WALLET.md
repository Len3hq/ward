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

## Who pays for gas

Two different mechanisms, and mixing them up costs a debugging session:

| Call                                     | Sent by                                         | Gas paid by                                                  |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| grant / revoke a Spend Permission        | the user's **smart account** (a user operation) | the smart account's own ETH — or `CDP_PAYMASTER_URL`, if set |
| `useSpendPermission`, `swap`, `transfer` | the **agent spender** (an EOA)                  | the spender's own ETH, always                                |

Nothing sponsors gas by default on Base mainnet, so a freshly generated smart
account fails its first `grant` with a CDP 400 (`insufficient balance to perform
useroperation: precheck failed`). Set `CDP_PAYMASTER_URL` and the user only ever
needs USDC. The agent spender needs ETH either way — the SDK exposes no paymaster
option for an EOA transaction.

## Chat flow

```
generate my wallet           → creates the smart account + spender, writes ward.wallet
grant a $100 daily permission → on-chain Spend Permission, ward.wallet.spend_permission = active
swap $40 usdc for eth        → pull → swap → **sweep the proceeds to your smart account**
send $10 to 0xAbC…            → pull → transfer USDC to any Base address
revoke my permission         → on-chain revoke + pauses every spend action in memory
pause swaps                   → memory-only revocation of one action type
```

`generate_wallet` / `grant_permission` / `revoke` are deterministic (the `wallet`
node), not LLM tool calls — they work without `OPENAI_API_KEY`.

## Swap, in full

```
useSpendPermission(user's smart account → agent spender, $N USDC)
spender.swap({ fromToken, toToken, fromAmount, slippageBps: 150 })
spender.transfer(bought token → user's smart account)      ← the sweep
```

The third step is not optional. `spender.swap()` returns a transaction hash and
nothing about the output, so the amount received is measured as the **delta in the
spender's balance** around the swap, and only that delta is forwarded — which is what
leaves the spender its own ETH for gas even when the bought token is native ETH.

If the sweep does not happen, the reply says so instead of reporting a completed
swap: the proceeds are still held by the agent spender, and a user who was told
otherwise would have no reason to go looking.

**Tokens are a fixed map** — `USDC`, `WETH`, `ETH`, `CBETH` on Base mainnet. Anything
else fails with `unknown token X on base`. This is not a general DEX interface.

## Send

`send $10 to 0x…` moves USDC from the user's smart account to any Base address, in
two steps: pull within the Spend Permission, then transfer from the spender. The pull
is a hard error without an active permission — sending Ward's own float because a
permission was missing would be the worst failure available here.

`send` is a full `ActionType`, so it shares the daily cap with swaps, x402 purchases
and ACP jobs, `revoke` pauses it like anything else, and an MCP grant can name it.
The confirmation always prints the destination address in full: it is the one field a
user cannot sanity-check from a summary, and the one that cannot be undone.

## Verify live

The CDP field names in `src/wallet/cdp.ts` (`listSpendPermissions` shape,
`waitForUserOperation` params, token-balance shape) are from the SDK's type
declarations. Confirm against a live project once:

```sh
WARD_CDP_TEST=1 BASE_NETWORK=base-sepolia bun test test/wallet.cdp.test.ts
```

If a call breaks, fix only `src/wallet/cdp.ts` — nothing else depends on the CDP
surface.
