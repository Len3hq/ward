import { createHash, randomBytes } from "node:crypto";

import {
  ACTION_TYPES,
  appendJournalEvent,
  forgetMcpGrant,
  read,
  readLinkCode,
  readMcpGrant,
  readMcpGrants,
  readWallet,
  writeLinkCode,
  writeMcpGrant,
  type ActionType,
  type Channel,
  type McpGrant,
} from "../../memory/index.ts";

/**
 * Execution grants for MCP tokens (Phase 16.2).
 *
 * **Nothing here authorizes anything yet.** 16.2 ships the object, the commands that
 * create it and the ability to see it; 16.3 is what makes `ward_execute_action`
 * appear. Shipping the authority object before the code that consumes it is
 * deliberate — it can be reviewed, granted, listed and revoked in production while
 * still being, by construction, incapable of permitting a spend.
 *
 * The shape is Ward's own Spend Permission one level up: capped per action, capped
 * per day, scoped to an allow-list of action types, expiring, revocable, and issued
 * only from an authenticated DM. It can only narrow what the user may already do.
 */

/** No grant may outlive this, however the user words it. */
export const MAX_GRANT_DAYS = 30;
export const DEFAULT_GRANT_DAYS = 7;
/** How long a proposed grant waits for its confirmation. */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;

/**
 * A token's public handle. The account id is a sha256; the user needs something they
 * can type, and eight hex characters distinguish the handful of tokens one person
 * holds. Never used to *look up* a grant — only to find the full hash first.
 */
export function tokenRef(tokenHash: string): string {
  return tokenHash.slice(0, 8);
}

/** Short aliases, because `x402_data_purchase` is not a thing anyone types twice. */
const ALIASES: Record<string, ActionType> = {
  x402: "x402_data_purchase",
  data: "x402_data_purchase",
  x402_data_purchase: "x402_data_purchase",
  swap: "swap",
  acp: "acp_job",
  acp_job: "acp_job",
};

export function parseActionTypes(input: string): ActionType[] | null {
  const parts = input
    .split(/[,\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const out = new Set<ActionType>();
  for (const part of parts) {
    if (part === "all") {
      for (const a of ACTION_TYPES) out.add(a);
      continue;
    }
    const mapped = ALIASES[part];
    if (!mapped) return null;
    out.add(mapped);
  }
  return [...out];
}

/** A grant that is neither revoked nor expired. Everything else is `null`. */
export async function liveGrant(
  tokenHash: string,
  now: Date = new Date(),
): Promise<McpGrant | null> {
  const grant = await readMcpGrant(tokenHash);
  if (grant === null) return null;
  if (grant.revoked_at !== null) return null;
  if (Date.parse(grant.expires_at) <= now.getTime()) return null;
  return grant;
}

/**
 * What this token has spent today, from the one shared ledger.
 *
 * Derived rather than stored, exactly as `spentToday()` derives the user's own
 * number — two authorities reading one ledger, so a grant can never disagree with
 * the record about what happened. Returns 0 until 16.3 starts tagging entries.
 */
export async function grantSpentToday(
  userId: string,
  tokenHash: string,
  now: Date = new Date(),
): Promise<number> {
  const record = await read(userId);
  if (record === null) return 0;
  const today = now.toISOString().slice(0, 10);
  return record.spent_ledger
    .filter((e) => e.via_token === tokenHash && e.ts.slice(0, 10) === today)
    .reduce((sum, e) => sum + e.amount_usd, 0);
}

export interface GrantRequest {
  userId: string;
  tokenHash: string;
  actionTypes: ActionType[];
  perActionUsd: number;
  dailyUsd: number;
  days: number;
  channel: Channel;
}

export type GrantCheck = { ok: true } | { ok: false; message: string };

/**
 * Everything that must be true before a grant is even offered for confirmation.
 *
 * A grant wider than the user's own caps is the interesting one: it would not be
 * dangerous, since `min()` still applies, but it would be a lie — the readback would
 * promise headroom that does not exist. Refusing is clearer than silently clamping.
 */
export async function checkGrant(request: GrantRequest): Promise<GrantCheck> {
  const record = await read(request.userId);
  if (record === null) {
    return {
      ok: false,
      message: "You have no authorization record, so there is nothing to grant.",
    };
  }
  if (request.perActionUsd <= 0 || request.dailyUsd <= 0) {
    return { ok: false, message: "Both limits have to be greater than zero." };
  }
  if (request.perActionUsd > request.dailyUsd) {
    return { ok: false, message: "The per-action limit can't be more than the daily limit." };
  }
  if (request.days <= 0 || request.days > MAX_GRANT_DAYS) {
    return { ok: false, message: `Grants last between 1 and ${MAX_GRANT_DAYS} days.` };
  }

  // Granting execution authority when the chain cannot pay is promising something
  // that cannot happen — and failing here is far clearer than failing mid-spend.
  const wallet = await readWallet(request.userId);
  const permission = wallet?.spend_permission ?? null;
  if (permission === null || permission.status !== "active") {
    return {
      ok: false,
      message:
        "There's no active on-chain spend permission, so a client couldn't spend even if " +
        'you granted it. Say "grant a $N daily permission" first.',
    };
  }

  const caps = record.standing_caps;
  if (request.perActionUsd > caps.per_action_limit_usd) {
    return {
      ok: false,
      message:
        `That per-action limit ($${request.perActionUsd}) is above your own ` +
        `($${caps.per_action_limit_usd}). A grant can only narrow what you can do, never widen it.`,
    };
  }
  if (request.dailyUsd > caps.daily_limit_usd) {
    return {
      ok: false,
      message:
        `That daily limit ($${request.dailyUsd}) is above your own ($${caps.daily_limit_usd}). ` +
        "A grant can only narrow what you can do, never widen it.",
    };
  }
  return { ok: true };
}

/** The plain-language readback. This is the sentence the user is actually approving. */
export function describeGrant(request: GrantRequest, ref: string): string {
  const actions = request.actionTypes.map((a) => a.replace(/_/g, " ")).join(", ");
  return [
    `Token ${ref} would be able to spend **without asking you first**:`,
    "",
    `· only these actions: ${actions}`,
    `· at most $${request.perActionUsd} per action`,
    `· at most $${request.dailyUsd} per day`,
    `· for ${request.days} day${request.days === 1 ? "" : "s"}, then it stops on its own`,
    "",
    "It still can't exceed your own caps or your on-chain allowance, every spend is " +
      "announced here, and you can revoke it at any time.",
  ].join("\n");
}

// --- the confirmation step ---

/**
 * A proposed grant, parked until the user confirms it.
 *
 * Reuses the link-code storage: same digest-keyed HOT state, same TTL, same
 * single-use burn. The code is never stored, only its hash — so what lands in Sibyl
 * Memory cannot be replayed into a grant by someone reading the store.
 */
function pendingKey(code: string): string {
  return createHash("sha256").update(`ward-grant:${code.toUpperCase()}`).digest("hex");
}

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function confirmCode(): string {
  const bytes = randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export async function proposeGrant(
  request: GrantRequest,
  now: Date = new Date(),
): Promise<{ code: string }> {
  const code = confirmCode();
  await writeLinkCode(pendingKey(code), {
    ward_user_id: request.userId,
    minted_on: request.channel,
    minted_by: JSON.stringify({
      token_hash: request.tokenHash,
      action_types: request.actionTypes,
      per_action_limit_usd: request.perActionUsd,
      daily_limit_usd: request.dailyUsd,
      days: request.days,
    }),
    minted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CONFIRM_TTL_MS).toISOString(),
    used_at: null,
    used_by: null,
  });
  return { code };
}

export type ConfirmResult =
  { ok: true; grant: McpGrant; ref: string } | { ok: false; message: string };

export async function confirmGrant(
  code: string,
  userId: string,
  channel: Channel,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const key = pendingKey(code.trim());
  const pending = await readLinkCode(key);
  if (pending === null) return { ok: false, message: "I don't know that confirmation code." };
  if (pending.used_at !== null) {
    return { ok: false, message: "That code has already been used." };
  }
  if (Date.parse(pending.expires_at) <= now.getTime()) {
    return { ok: false, message: "That confirmation expired. Start the grant again." };
  }
  // A code shown in one principal's DM must not be usable by another.
  if (pending.ward_user_id !== userId) {
    return { ok: false, message: "I don't know that confirmation code." };
  }

  const detail = JSON.parse(pending.minted_by ?? "{}") as {
    token_hash: string;
    action_types: ActionType[];
    per_action_limit_usd: number;
    daily_limit_usd: number;
    days: number;
  };

  // Re-check against the record as it is NOW, not as it was when proposed — the user
  // may have tightened their caps in between, and the readback is not a reservation.
  const recheck = await checkGrant({
    userId,
    tokenHash: detail.token_hash,
    actionTypes: detail.action_types,
    perActionUsd: detail.per_action_limit_usd,
    dailyUsd: detail.daily_limit_usd,
    days: detail.days,
    channel,
  });
  if (!recheck.ok) return { ok: false, message: recheck.message };

  // Burn first, as with a link code: a crash after this costs a confirmation the user
  // can redo, where the other order leaves a live code that already worked.
  await writeLinkCode(key, { ...pending, used_at: now.toISOString(), used_by: userId });

  const grant = await writeMcpGrant({
    ward_user_id: userId,
    token_hash: detail.token_hash,
    action_types: detail.action_types,
    per_action_limit_usd: detail.per_action_limit_usd,
    daily_limit_usd: detail.daily_limit_usd,
    granted_at: now.toISOString(),
    granted_on: channel,
    expires_at: new Date(now.getTime() + detail.days * 86_400_000).toISOString(),
    revoked_at: null,
  });

  await appendJournalEvent(
    userId,
    "mcp_grant",
    `granted token ${tokenRef(grant.token_hash)} ${grant.action_types.join("/")} ` +
      `$${grant.per_action_limit_usd}/action $${grant.daily_limit_usd}/day until ${grant.expires_at}`,
    { ...grant },
    channel,
  );

  return { ok: true, grant, ref: tokenRef(grant.token_hash) };
}

/** Revoke by the short handle the user was shown. */
export async function revokeGrant(userId: string, ref: string, channel: Channel): Promise<boolean> {
  const grants = await readMcpGrants(userId);
  const match = grants.find(
    (g) => tokenRef(g.token_hash) === ref.toLowerCase() && g.revoked_at === null,
  );
  if (!match) return false;

  await forgetMcpGrant(userId, match.token_hash);
  await appendJournalEvent(
    userId,
    "mcp_grant_revoked",
    `revoked grant on token ${ref}`,
    { token_hash: match.token_hash },
    channel,
  );
  return true;
}

/** Live grants only, for listing. */
export async function liveGrants(
  userId: string,
  now: Date = new Date(),
): Promise<Array<{ ref: string; grant: Omit<McpGrant, "ward_user_id"> }>> {
  const grants = await readMcpGrants(userId);
  return grants
    .filter((g) => g.revoked_at === null && Date.parse(g.expires_at) > now.getTime())
    .map((g) => ({ ref: tokenRef(g.token_hash), grant: g }));
}
