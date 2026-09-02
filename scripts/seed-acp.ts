/**
 * Pre-seed one already-evaluated ACP job so a fresh-session demo shows the agent
 * citing an *existing* trust score (plan §3.3 — real hindsight evaluation takes
 * time you don't have on camera).
 *
 *   bun run scripts/seed-acp.ts <telegram_id> [counterparty_id]
 *
 * Uses whatever memory backend the env selects (SIBYL_MEMORY_MODE).
 */
import { appendAcpJob, initialize, read } from "../memory/index.ts";

const [, , tgId, counterparty = "agent://ward-analyst.stub"] = process.argv;

if (!tgId) {
  console.error("usage: bun run scripts/seed-acp.ts <telegram_id> [counterparty_id]");
  process.exit(1);
}

if ((await read(tgId)) === null) {
  await initialize(tgId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  console.log(`initialized authorization for ${tgId}`);
}

await appendAcpJob(tgId, {
  ts: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  counterparty_id: counterparty,
  job_type: "token_risk",
  outcome_summary:
    "flagged mint-authority + LP-lock risk; token rugged 2 days later — call was correct",
  trust_delta: 0.4,
});

const record = await read(tgId);
console.log(
  `seeded 1 evaluated job for ${counterparty}. acp_job_history now has ${record?.acp_job_history.length} entr(y/ies).`,
);
