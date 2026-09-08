# Demo — 2 to 5 minutes

**One arc:** _recall → decide → pay/hire → execute — and none of it works without
Sibyl Memory._

Two terminals + Telegram open. Show a clock or timestamp overlay for the
fresh-session moment.

## Setup (off camera)

```sh
set -a; source .env; set +a        # TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, OPENAI_API_KEY, CDP_*, ACP_MODE
sibyl status                        # confirm Pro tier + DB path (or SIBYL_MEMORY_MODE=fs)
bun run scripts/seed-acp.ts telegram:<YOUR_TG_ID>   # one already-evaluated ACP job, so trust isn't 0.50 on camera
bun run dev                         # terminal 1 — leave running
```

Confirm the boot line: `Ward connected to Telegram as @… (…, model gpt-4o-mini).`
For Beat 5b, also `Ward connected to Discord as … (DM-only).` — and have the Discord
DM open in a second window, ready to cut to. Ward is DM-only; a guild channel will
just tell you to DM it.

## Beat 1 — onboarding + fresh-session recall (≈45s)

In Telegram:

```
you: hey
ward: … how would you describe your risk tolerance …
you: moderate
you: 50
you: 100
ward: Locked in: moderate risk, $50 per action, $100 per day …
```

**Show the clock.** Then `/newsession` and:

```
you: what am I allowed to do?
ward: Risk profile: moderate · Caps: $50 per action · $100 per day
      Spent today: $0.00 of $100 … Known counterparties: agent://… trust 0.7X over 1 job
```

Say it out loud: _brand-new conversation, nothing in the chat history — every
number came from Sibyl Memory, including the trust score from a job we ran days
ago._

## Beat 2 — the memory-gated refusal (≈40s) — THE eligibility moment

Do it **in Telegram, on camera**. Cutting to a terminal to run a script invites the
obvious question — is that thing really the same memory? — and `/forget_me` (Phase 17)
answers it by never leaving the chat.

```
you:  /forget_me
ward: This deletes the authorization record I act under …
        · your limits — $50 per action, $100 per day (moderate)
        · your spend history — 2 entries
        …
      To go ahead, send: /forget_me K7M2XQ
you:  /forget_me K7M2XQ
ward: Deleted. I have no authorization on file for you any more, so I won't move any
      funds — not even where the chain would still allow it.
```

Then, the same request as before:

```
you: get me a risk score on PEPE
ward: I have no authorization on file for you in Sibyl Memory, so I won't move any
      funds — not even within what the chain would allow. Say "set me up" …
```

Say it: _the agent is still running. It just has no basis for authority. That's the
gate._ Worth adding: _the wallet is untouched — this deleted the policy, not the
money._ Then re-onboard (say "set me up", `moderate` / `50` / `100`) to continue.

> `bun run scripts/forget-auth.ts <YOUR_TG_ID>` still does the same delete from a
> terminal, and it is the version a judge can run against the repo without a chat
> account. Use it if the two-step is too slow for the cut you are making.

## Beat 3 — generate + grant on-chain (≈30s)

```
you: generate my wallet
ward: Wallet generated on base-sepolia. Your smart account: 0x… Agent spender: 0x…
you: grant a $100 daily permission
ward: Grant an on-chain spend permission: $100 USDC per day, spender 0x….
      This is a transaction on base-sepolia and costs gas.
      It lets me move up to that much USDC without asking again — x402 data and ACP
      hires draw on it. Confirm? (yes / no)
you: yes
ward: Granted an on-chain spend permission: $100 USDC per 1 day … tx 0x…
      I now act within min(your $100 memory cap, this $100 on-chain allowance).
```

Worth saying on camera: granting is the one action that _enlarges_ what Ward may do,
so it asks first — the same yes/no every spend gets. Revoking never asks, because it
only ever takes authority away.

Open the `tx` on sepolia.basescan.org. The address is monospaced in both apps, so a
tap (Telegram) or the code block's copy button (Discord) puts it on the clipboard —
which is how you fund it without transcribing 42 hex characters.

```
you: what is my balance
ward: Your wallet 0x… on base-sepolia:
      • USDC: $100.00
      • ETH: 0.0021 (gas)
      Spend permission: active, $100 USDC per 1 day.
      Spent today: $0.00 of your $100 daily cap (remaining $100.00).
```

That number is read from chain each time it is asked for, never from the model.

## Beat 4 — one x402 payment on Base (≈30s)

```
you: get me a risk score on PEPE
ward: Buy "Token Risk Score" (~$0.05). $0.00 of your $100 daily cap used … Confirm?
you: yes
ward: Paid $0.05 for "Token Risk Score". https://sepolia.basescan.org/tx/0x…
      { risk_score: …, flags: […] }
```

Open the tx. Say: _the spend just went on the same ledger as everything else._

## Beat 5 — the shared ledger (≈25s)

A second purchase, a different endpoint — to show the running total, not the price:

```
you: what are whales doing in AERO
ward: Buy "Whale Flows" (~$0.001). $0.05 of your $100 daily cap used … Confirm?
you: yes
ward: Paid $0.001 for "Whale Flows". https://sepolia.basescan.org/tx/0x…
```

Say: _every action type — data, hires — sums into one number against one cap. The
per-action and daily limits are enforced the same way on all of them
([`test/daily-cap.test.ts`](../test/daily-cap.test.ts))._

> Swap and USDC transfer are built but switched off right now
> ([`src/agent/transfers.ts`](../src/agent/transfers.ts)) — a `swap …` request is
> declined and neither shows up in `/start`. Don't demo them.

## Beat 5b — the same cap, from a different app (≈35s) — THE multi-channel moment

Only if Discord is configured. This is the strongest single demonstration that
**memory, not the chat surface, is the authorization substrate.**

On Telegram, ask for the Discord link:

```
you:  /link discord
ward: Connect Discord in one click:

      https://<your-domain>/link/discord/kQ8w…

      Open it and I'll pick up from there — same limits, same spend history, same
      wallet. It works once, within 5 minutes.
```

Tap it on camera. Discord's authorize screen appears, you approve, and the page says
**Linked** — then cut to Discord, where the DM is _already waiting_. A different app,
a different account, no shared login, and nothing typed.

Cut back to Telegram for one second: the announcement is already there. Say
_it tells the original account, so a stolen link can't be used quietly._

> If one-click linking isn't configured on the machine you're demoing from
> (`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `WARD_PUBLIC_URL`), fall back to
> `/link` for a code and redeem it with `/link WARD-4K7M-2XQP` in the Discord DM.
> Same result, one more step on camera.

Now, still on Discord, ask what you're allowed to do:

```
you:  what am I allowed to do?
ward: Risk profile: moderate · Caps: $50 per action · $100 per day
      Spent today: $0.05 of $100 — the two purchases you made on Telegram.
```

Say: _I never told Discord my limits or my spend history. It read the same record.
A second app is not a second allowance — one cap, one ledger._ (For a breach on
camera, onboard with a `$1` daily cap so a third purchase is refused here.)

Optionally revoke here and switch back to Telegram to show it refuse — the same point
as Beat 6, made across two apps.

## Beat 5c — an agent acting on its own, and the leash (≈40s)

Only if an MCP client is connected. This is the strongest demonstration that the
authorization is the _record_, not the surface.

On Telegram, grant a client a deliberately tiny allowance:

```
you:  /mcp grant a3f9c2d1 x402 0.05 0.10 1
ward: Token a3f9c2d1 would be able to spend **without asking you first**:
      · only these actions: x402 data purchase
      · at most $0.05 per action
      · at most $0.10 per day
      · for 1 day, then it stops on its own
      To apply it, send: /mcp confirm K7M2XQ
you:  /mcp confirm K7M2XQ
```

Now in the LLM client — Claude, Cursor, whatever is connected — ask it for a risk
score. It calls `ward_execute_action` and the purchase happens with **nobody
confirming anything**. Cut to Telegram: the announcement is already there, naming the
amount and the token.

Then ask it for a third purchase on the same day. It comes back refused:

```
Blocked at execution — $0.05 exceeds the $0.10 you granted this client
($0.00 left today). Nothing moved.
```

Say it: _I gave that agent ten cents and a day. It spent inside that and then it
couldn't, and I was told every time. Take it back —_

```
you:  /mcp stop
ward: Stopped. 1 grant revoked: a3f9c2d1.
      That client can still read your limits and propose spends for you to confirm —
      it just can't act on its own.
```

**The point to land:** the client never had authority of its own. It had a loan of
yours, written in Sibyl Memory, bounded by your caps and your on-chain allowance, and
it ended the moment you said so.

## Beat 6 — revoke the Spend Permission on-chain (≈30s)

```
you: revoke my permission, I'm done for the day
ward: Revoked your spend permission and paused every spend action.
      On-chain revocation tx 0x… I can't move funds until you grant a new permission.
you: get me a risk score on PEPE
ward: You've paused data purchases. I won't do that until you lift the pause.
```

Open the revoke tx. Say: _revoke on-chain, the agent can't spend — instantly,
mid-session._

## Beat 7 — ACP hire + trust write-back (≈40s, only if `ACP_MODE=virtuals` settled)

```
you: hire an agent to assess WOOF
ward: Hire agent://0x… (trust 0.7X, 1 prior job) to assess WOOF for ~$0.5. … Confirm?
you: yes
ward: Hired agent://0x… to assess WOOF.
      Result: risk elevated (…) …
      Trust in this counterparty: 0.7X → 0.7Y.
```

Say: _it paid another agent, checked the result, and updated how much it trusts
that agent — in memory, for next time._ **If the real ACP path didn't settle in the
spike, cut this beat — do not run the stub on camera.**

## Close (≈15s)

_Recall, decide, pay, hire, execute. Delete `ward.authorization` from Sibyl Memory
and the agent has no policy — it refuses, even though the chain would still allow
the spend. The memory is the authorization._

## Notes

- If CDP/x402 aren't live-verified yet, run beats 3-6 on stubs (`SIBYL_MEMORY_MODE`
  aside, no `CDP_*`) and say plainly that the on-chain settlement is simulated —
  the memory loop is identical. Better an honest stub than a faked chain artifact.
- `/newsession` between beats keeps the transcript clean and re-proves recall.
- Beat 5b needs both gateways in **one** process (`bun run dev` starts whichever have
  tokens). Two processes would each hold their own conversation threads; the Sibyl
  Memory record would still be shared, but the link announcement would not arrive.
- Don't show `/link mcp` on camera unless you intend to explain it — a bearer token
  on screen invites the wrong question. The MCP surface is a README/`MCP.md` story:
  it can read and propose, never approve, and it spends only inside a grant the user
  issued from a human channel.
- `scripts/forget-auth.ts` and `scripts/seed-acp.ts` both take either
  `telegram:<id>` or a `ward_<ulid>`, so you never need to look the principal up.
