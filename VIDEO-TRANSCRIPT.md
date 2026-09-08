# Ward — 5-minute demo video transcript

**Format:** voiceover (VO) + on-screen action (SCREEN). Target 5:00. ~760 spoken words.
Two terminals + Telegram visible. A clock/timestamp overlay is on-screen for the
fresh-session beat.

> If Base isn't live-verified on the machine you record from, run beats 4–7 on stubs
> and say once, plainly: _"On-chain settlement here is simulated on Base Sepolia; the
> memory loop is identical."_ An honest stub beats a faked chain artifact.

---

## 0:00 – 0:40 · The problem, and who has it

**SCREEN:** Title card — "Ward". Then a scroll through a couple of real
agent-trading forum threads (redacted), the phrase _"but the bot has my keys"_
highlighted.

**VO:**
"If you've looked at letting an AI agent trade for you, you've hit the same wall
everyone hits: to be useful, the agent needs to spend your money — and the moment it
can spend your money, it can spend *all* of your money. 'The agent has my keys' is
the objection in every one of these threads. So people don't do it. The pain isn't
that agents are bad at trading. It's that there's no way to hand one a *limited*
amount of authority and trust that the limit holds."

---

## 0:40 – 1:10 · The product

**SCREEN:** Ward's landing page, then the Telegram chat. Onboarding exchange types
through: `moderate` → `50` → `100` → Ward replies _"Locked in: moderate risk, $50
per action, $100 per day."_

**VO:**
"Ward is a personal crypto agent on Telegram whose *memory* is the authorization
layer. You onboard once — a risk label, a per-action limit, a daily limit. That's it.
From then on Ward acts only inside those limits, and it can never widen them on its
own. The limits aren't in the code. They're a record in Sibyl Memory. And that
distinction is the whole product: delete the record, and Ward has no basis for
authority — it refuses to move a cent, even when the blockchain would still let it."

---

## 1:10 – 1:45 · Fresh-session recall  ⏱ (clock visible)

**SCREEN:** Point at the on-screen clock. Type `/newsession`. New empty thread.
Then: `what am I allowed to do?`
Ward: _"Risk profile: moderate · Caps: $50 per action · $100 per day · Spent today:
$0.00 of $100 · Known counterparties: agent://… trust 0.72 over 1 job."_

**VO:**
"Here's a brand-new session. Empty chat history — nothing above this line. I ask what
I'm allowed to do. Every number in that answer — the caps, the amount spent today, and
a trust score for a counterparty we hired *days* ago — is read back from Sibyl Memory.
Ward didn't remember this because it's still 'running.' It remembered because the
policy, the ledger, and the reputation all live in memory, and a cold start reads
them the same as a warm one."

---

## 1:45 – 2:25 · The memory-gated refusal  (the eligibility moment)

**SCREEN:** Terminal 2: `bun run scripts/forget-auth.ts <id>` → prints the full
record, then `✓ Deleted. read(<id>) is now null.`
Back in Telegram: `swap $20 usdc for eth`
Ward: _"I have no authorization on file for you in Sibyl Memory, so I won't move any
funds — not even within what the chain would allow. Say 'set me up' to start over."_

**VO:**
"Now I delete the authorization record straight out of Sibyl Memory. Same agent, same
wallet, still connected. I ask for a small swap — twenty dollars, well under every
limit it had a minute ago. It refuses. Not 'I can't reach a server' — it *explains*:
there's no authorization on file, so it won't act. That's the gate. The agent's power
is exactly the memory, and nothing else."

**SCREEN:** Re-onboard quickly (`set me up` → `moderate` / `50` / `100`).

---

## 2:25 – 2:55 · Grant an on-chain spend permission

**SCREEN:** `generate my wallet` → smart account + agent spender addresses.
`grant a $100 daily permission` → confirmation prompt → `yes` →
_"Granted an on-chain spend permission: $100 USDC per day … tx 0x…
I now act within min(your $100 memory cap, this $100 on-chain allowance)."_
Open the tx on sepolia.basescan.org.

**VO:**
"Ward mirrors your daily limit on-chain, as a revocable USDC Spend Permission on
Base. Notice it asked before granting — with the same yes/no every spend gets —
because granting is the *one* action that enlarges what Ward can do. From here on,
every spend is checked against the smaller of the two: your memory cap, and the
on-chain allowance. Two independent brakes."

---

## 2:55 – 3:30 · One x402 payment on Base

**SCREEN:** `get me a risk score on PEPE`
Ward: _"Buy 'Token Risk Score' (~$0.05). $0.00 of your $100 daily cap used. Confirm?"_
→ `yes` → _"Paid $0.05 for 'Token Risk Score'. https://…/tx/0x…"_ + the JSON result.
Open the tx.

**VO:**
"When Ward needs data it can't get for free, it pays for it — here, a token-risk
score over x402, a nickel, settled on Base. The important part isn't the payment.
It's that the five cents just landed on the *same* ledger in Sibyl Memory as
everything else Ward spends. One running total, every action type."

---

## 3:30 – 4:05 · A capped swap, and a limit

**SCREEN:** `swap $40 usdc for eth`
Ward: _"Swap $40 USDC → ETH. $0.05 of your $100 daily cap used, $99.95 left. Confirm?"_
→ `yes` → tx link.
Then: `swap $70 usdc for eth`
Ward: _"That's $70, over your $50 per-action limit. Lower the amount, or raise the cap."_

**VO:**
"A forty-dollar swap goes through — confirmed with the real remaining balance, read
from memory and from chain, not guessed by the model. Then I ask for seventy in one
shot. Over the fifty-dollar per-action limit I set at the start. Blocked before it
ever reaches a confirmation screen. The cap I typed once, three sessions ago, is
still the cap."

---

## 4:05 – 4:40 · Hiring another agent, and remembering the outcome

**SCREEN:** `hire an agent to assess WOOF`
Ward: _"Hire agent://0x… (trust 0.72, 1 prior job) to assess WOOF for ~$0.50. Confirm?"_
→ `yes` → result summary → _"Trust in this counterparty: 0.72 → 0.78."_

**VO:**
"Ward doesn't only pay APIs — it hires other agents. It posts a job on Virtuals ACP,
pays through escrow that settles on Base, checks the result against public data, and
then writes back a trust delta: this counterparty was worth it, nudge the score up.
The *next* time Ward needs this kind of analysis, it reads that score first and
picks who to hire. Memory as a reputation ledger for agent-to-agent commerce."

---

## 4:40 – 5:00 · Close

**SCREEN:** `revoke my permission, I'm done for the day` →
_"Revoked … on-chain revocation tx 0x… I can't move funds until you grant a new
permission."_ Then `swap $10 usdc for eth` → _"You've paused swap."_
Cut to the deleted-record refusal from beat 3. Final card: **"The memory is the
authorization."**

**VO:**
"Revoke the permission on-chain and Ward can't spend — instantly, mid-session.
Delete the record in Sibyl Memory and it has no policy at all, so it refuses
everything, even the spends the chain would still allow. Recall, decide, pay, hire,
execute — and not one step of it works without the memory. That's Ward."

---

## Cue sheet

| Time | Beat | Key on-screen proof |
| --- | --- | --- |
| 0:00 | Problem | real forum threads, "the bot has my keys" |
| 0:40 | Product | onboarding: `moderate / 50 / 100` |
| 1:10 | **Fresh-session recall** | visible clock · `/newsession` · caps + trust from memory |
| 1:45 | Deletion refusal | `forget-auth.ts` → `read() is now null` → refusal with reason |
| 2:25 | Grant | basescan tx · `min(memory cap, on-chain allowance)` |
| 2:55 | x402 | basescan tx · "same ledger" |
| 3:30 | Swap + limit | basescan tx · `$70 over your $50 per-action limit` |
| 4:05 | ACP hire | `trust 0.72 → 0.78` write-back |
| 4:40 | Close | on-chain revoke tx · paused-swap refusal |
