# Ward — 5-minute demo video transcript

**Format:** voiceover (VO) + on-screen action (SCREEN). Target 5:00. ~790 spoken words.
Two terminals + Telegram visible. A clock/timestamp overlay is on-screen for the
fresh-session beat.

> If Base isn't live-verified on the machine you record from, run beats 4–7 on stubs
> and say once, plainly: _"On-chain settlement here is simulated on Base Sepolia; the
> memory loop is identical."_ An honest stub beats a faked chain artifact.

---

## 0:00 – 0:45 · The problem, and who has it

**SCREEN:** Title card — "Ward". Then two panels side by side, each marked with a red
✗: on the left, a wallet prompt reading _"Approve unlimited USDC"_; on the right, a
stack of _"Approve this transaction?"_ pop-ups. Caption underneath: _"Your two
options today."_

**VO:**
"hello, we are the Len3 team and we built WARD.[PAUSE] Say you want an AI agent to handle some crypto for you — pay for market
data, hire another agent to research a coin. To do any of that on its own, it has to
be able to spend from your wallet. And today that's an all-or-nothing situation. You
either give it unlimited access or approve every transaction by hand — in which case it isn't really acting autonomously. One prompt injection, one leaked key, one bug in a loop, and there's nothing between the agent and your entire balance. There is no way to tell an agent _spend this much and not a dollar more_ and actually trust the limit will hold. So people don't give these agents real money — and the few who do, don't sleep well."

---

## 0:45 – 1:15 · The product

**SCREEN:** Ward's landing page, then the Telegram chat. Onboarding exchange types
through: `moderate` → `50` → `100` → Ward replies _"Locked in: moderate risk, $50
per action, $100 per day."_

**VO:**
"Ward is a personal crypto agent whose _memory_ is the authorization layer and it exist across channels (telegram, discord and MCP) with a persistent knowledge. You onboard once — a risk label, a per-action limit, a daily limit. That's it. From then on Ward acts only inside those limits, and it can never widen them on its own. The limits aren't in the code. They're a record in Sibyl Memory. And that distinction is the whole product: delete the record, and Ward has no basis for authority — it refuses to move a cent, even when the blockchain would still let it."

---

## 1:15 – 1:45 · Fresh-session recall ⏱ (clock visible)

**SCREEN:** Point at the on-screen clock. Type `/newsession`. New empty thread.
Then: `what am I allowed to do?`
Ward: _"Risk profile: moderate · Caps: $50 per action · $100 per day · Spent today:
$0.00 of $100 · Known counterparties: agent://… trust 0.72 over 1 job."_

**VO:**
"Here's a brand-new session. Empty chat history — nothing above this line. I ask what
I'm allowed to do. Every number in that answer — the caps, the amount spent today, and
a trust score for a counterparty we hired _days_ ago — is read back from Sibyl Memory.
Ward didn't remember this because it's still 'running.' It remembered because the
policy, the ledger, and the reputation all live in memory, and a cold start reads
them the same as a warm one."

---

## 1:45 – 2:25 · The memory-gated refusal (the eligibility moment)

**SCREEN:** Terminal 2: `bun run scripts/forget-auth.ts <id>` → prints the full
record, then `✓ Deleted. read(<id>) is now null.`
Back in Telegram: `get me a risk score on PEPE`
Ward: _"I have no authorization on file for you in Sibyl Memory, so I won't move any
funds — not even within what the chain would allow. Say 'set me up' to start over."_

**VO:**
"Now I delete the authorization record straight out of Sibyl Memory. Same agent, same
wallet, still connected. I ask for a five-cent data purchase — well under every limit
it had a minute ago. It refuses. Not 'I can't reach a server' — it _explains_:
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
because granting is the _one_ action that enlarges what Ward can do. From here on,
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
It's that the five cents just landed on the _same_ ledger in Sibyl Memory as
everything else Ward spends. One running total, every action type."

---

## 3:30 – 3:55 · One ledger, one cap

**SCREEN:** `what are whales doing in AERO`
Ward: _"Buy 'Whale Flows' (~$0.001). $0.05 of your $100 daily cap used. Confirm?"_
→ `yes` → tx link. Then: `what am I allowed to do?` → the readout now shows
_"Spent today: $0.051 of $100."_

**VO:**
"A second purchase, a different endpoint. Notice the daily-cap line — it already
knows about the first one. Every action type Ward can take, data and agent hires,
sums into a single number checked against a single cap. The per-action and daily
limits I set at the start bind every one of them, the same way, before anything is
confirmed."

---

## 3:55 – 4:40 · Hiring another agent, and remembering the outcome

**SCREEN:** `hire an agent to assess WOOF`
Ward: _"Hire agent://0x… (trust 0.72, 1 prior job) to assess WOOF for ~$0.50. Confirm?"_
→ `yes` → result summary → _"Trust in this counterparty: 0.72 → 0.78."_

**VO:**
"Ward doesn't only pay APIs — it hires other agents. It posts a job on Virtuals ACP,
pays through escrow that settles on Base, checks the result against public data, and
then writes back a trust delta: this counterparty was worth it, nudge the score up.
The _next_ time Ward needs this kind of analysis, it reads that score first and
picks who to hire. Memory as a reputation ledger for agent-to-agent commerce."

---

## 4:40 – 5:00 · Close

**SCREEN:** `revoke my permission, I'm done for the day` →
_"Revoked … on-chain revocation tx 0x… I can't move funds until you grant a new
permission."_ Then `get me a risk score on PEPE` → _"You've paused data purchases."_
Cut to the deleted-record refusal from beat 3. Final card: **"The memory is the
authorization."**

**VO:**
"Revoke the permission on-chain and Ward can't spend — instantly, mid-session.
Delete the record in Sibyl Memory and it has no policy at all, so it refuses
everything, even the spends the chain would still allow. Recall, decide, pay, hire,
execute — and not one step of it works without the memory. That's Ward."

---

## Cue sheet

| Time | Beat                     | Key on-screen proof                                           |
| ---- | ------------------------ | ------------------------------------------------------------- |
| 0:00 | Problem                  | two-panel ✗: "Approve unlimited USDC" vs endless approval pop-ups |
| 0:45 | Product                  | onboarding: `moderate / 50 / 100`                             |
| 1:15 | **Fresh-session recall** | visible clock · `/newsession` · caps + trust from memory      |
| 1:45 | Deletion refusal         | `forget-auth.ts` → `read() is now null` → refusal with reason |
| 2:25 | Grant                    | basescan tx · `min(memory cap, on-chain allowance)`           |
| 2:55 | x402                     | basescan tx · "same ledger"                                   |
| 3:30 | One ledger, one cap      | 2nd purchase · `Spent today: $0.051 of $100` carries across   |
| 3:55 | ACP hire                 | `trust 0.72 → 0.78` write-back                                |
| 4:40 | Close                    | on-chain revoke tx · paused-purchase refusal                  |
