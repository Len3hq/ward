/**
 * Pre-seed one already-evaluated ACP job so a fresh-session demo shows the agent
 * citing an *existing* trust score (plan §3.3 — real hindsight evaluation takes
 * time you don't have on camera).
 *
 *   bun run scripts/seed-acp.ts <ward_user_id | telegram:700100200> [counterparty_id]
 *
 * Takes the principal or a `<channel>:<account_id>` reference, like
 * `forget-auth.ts` — but unlike that one it will *create* the account on first use,
 * because the demo seeds before the user has ever messaged the bot. Given a channel
 * reference it does exactly what a first message would: mint a principal and link
 * the account to it.
 *
 * Uses whatever memory backend the env selects (SIBYL_MEMORY_MODE).
 */
import { appendAcpJob, initialize, read } from "../memory/index.ts";
import { isWardUserId, parseAccountRef, resolveUser } from "../src/identity/index.ts";

const [, , ref, counterparty = "agent://ward-analyst.stub"] = process.argv;

if (!ref) {
  console.error(
    "usage: bun run scripts/seed-acp.ts <ward_user_id | channel:account_id> [counterparty_id]",
  );
  process.exit(1);
}

async function resolveOrCreate(reference: string): Promise<string> {
  if (isWardUserId(reference)) return reference;
  const account = parseAccountRef(reference);
  if (!account) {
    throw new Error(
      `Could not read ${JSON.stringify(reference)}. Pass a ward_<ulid> id, or an ` +
        `account like "telegram:700100200".`,
    );
  }
  const { userId: resolved, created } = await resolveUser(account.channel, account.accountId);
  if (created) console.log(`created ${reference} → ${resolved}`);
  return resolved;
}

let userId: string;
try {
  userId = await resolveOrCreate(ref);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if ((await read(userId)) === null) {
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  console.log(`initialized authorization for ${userId}`);
}

await appendAcpJob(userId, {
  ts: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  counterparty_id: counterparty,
  job_type: "token_risk",
  outcome_summary:
    "flagged mint-authority + LP-lock risk; token rugged 2 days later — call was correct",
  trust_delta: 0.4,
});

const record = await read(userId);
console.log(
  `seeded 1 evaluated job for ${counterparty}. acp_job_history now has ${record?.acp_job_history.length} entr(y/ies).`,
);
