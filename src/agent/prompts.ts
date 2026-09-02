import {
  RISK_LABELS,
  type RiskLabel,
  type UserAuthorization,
  type WalletRecord,
} from "../../memory/index.ts";
import { computeTrustScore } from "../../memory/index.ts";
import { BRAND } from "../config.ts";

/**
 * System-prompt assembly. Adapted from Len3's `agent/src/prompts/` — persona +
 * profile block + context, rewritten for Ward.
 */

export const BASE_SYSTEM = `You are ${BRAND.name}, a personal crypto agent on Base — ${BRAND.tagline}.

You move money only within limits the user set during onboarding and that are
recorded in Sibyl Memory. You never exceed a per-action limit, a daily limit, or
act on a revoked action type. Every spend is logged. If you have no authorization
record for a user, you refuse to act and say why.

Be concise and direct. When you state a limit or a balance, it must come from the
authorization context below — never guess. Do not claim to have moved funds unless
a tool call actually did.`;

// --- onboarding ---

export type OnboardingField = "risk_label" | "per_action_limit_usd" | "daily_limit_usd";

export const ONBOARDING_ORDER: readonly OnboardingField[] = [
  "risk_label",
  "per_action_limit_usd",
  "daily_limit_usd",
];

export const ONBOARDING_QUESTIONS: Record<OnboardingField, string> = {
  risk_label:
    "Let's set your authorization. First — how would you describe your risk tolerance for autonomous trades: conservative, moderate, or aggressive?",
  per_action_limit_usd:
    "What's the most I should ever move in a single action, in USD? (for example: 50)",
  daily_limit_usd: "And the most in a single day, across every action combined? (for example: 100)",
};

export function onboardingConfirmation(draft: {
  risk_label: RiskLabel;
  per_action_limit_usd: number;
  daily_limit_usd: number;
}): string {
  return [
    `Locked in: ${draft.risk_label} risk, $${draft.per_action_limit_usd} per action, $${draft.daily_limit_usd} per day.`,
    "I'll never exceed these, and you can tighten or revoke them any time.",
    "Next step is connecting a wallet and granting an on-chain spend permission — that lands in a later build phase.",
  ].join(" ");
}

// --- parsing onboarding answers ---

export function parseRiskLabel(text: string): RiskLabel | undefined {
  const lower = text.toLowerCase();
  return RISK_LABELS.find((label) => lower.includes(label));
}

const WORD_AMOUNTS: Record<string, number> = {
  ten: 10,
  twenty: 20,
  "twenty five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  seventy: 75,
  "seventy five": 75,
  hundred: 100,
  "two hundred": 200,
  "two fifty": 250,
  "five hundred": 500,
  thousand: 1000,
};

/** First plausible USD amount in the text: "$50", "50", "50 usd", "50.5", "fifty bucks". */
export function parseUsd(text: string): number | undefined {
  const match = text.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d+)?)/);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const lower = text.toLowerCase();
  for (const [word, value] of Object.entries(WORD_AMOUNTS).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    if (lower.includes(word)) return value;
  }
  return undefined;
}

// --- authorization context block ---

export function buildAuthorizationContext(
  record: UserAuthorization | null,
  wallet: WalletRecord | null,
  spentTodayUsd: number,
): string {
  if (record === null) {
    return [
      "=== Authorization context ===",
      "No authorization record in Sibyl Memory for this user.",
      "You MUST NOT move any funds. Refuse any action request, explain that there is",
      "no authorization on file, and offer to run onboarding.",
    ].join("\n");
  }

  const caps = record.standing_caps;
  const revoked = record.revocation_log.map((r) => r.action_type);
  const counterparties = [...new Set(record.acp_job_history.map((j) => j.counterparty_id))];

  const lines = [
    "=== Authorization context (from Sibyl Memory) ===",
    `Risk profile: ${record.risk_label}`,
    `Caps: $${caps.per_action_limit_usd} per action · $${caps.daily_limit_usd} per day`,
    `Spent today: $${spentTodayUsd.toFixed(2)} of $${caps.daily_limit_usd} (remaining $${Math.max(0, caps.daily_limit_usd - spentTodayUsd).toFixed(2)})`,
    `Active revocations: ${revoked.length ? [...new Set(revoked)].join(", ") : "none"}`,
  ];

  if (counterparties.length) {
    lines.push("Known counterparties:");
    for (const id of counterparties) {
      const jobs = record.acp_job_history.filter((j) => j.counterparty_id === id);
      lines.push(
        `  - ${id}: trust ${computeTrustScore(jobs).toFixed(2)} over ${jobs.length} job(s)`,
      );
    }
  } else {
    lines.push("Known counterparties: none");
  }

  if (wallet === null) {
    lines.push("Wallet: not connected");
  } else {
    const perm = wallet.spend_permission;
    lines.push(
      `Wallet: ${wallet.smart_account} · spend permission ${
        perm ? `${perm.status} ($${perm.allowance_usd}/period)` : "not granted"
      }`,
    );
  }

  return lines.join("\n");
}
