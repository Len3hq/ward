import { createHash, randomInt } from "node:crypto";

import {
  appendJournalEvent,
  forgetIdentity,
  read,
  readLinkCode,
  readRateWindow,
  readWallet,
  writeLinkCode,
  writeRateWindow,
  type Channel,
} from "../../memory/index.ts";
import { accountsFor, link, resolveExisting } from "./index.ts";

/**
 * The one-time link code — how Ward is *told* that two channel accounts are the
 * same person, since it can never work that out for itself.
 *
 * The proof is possession: the code is shown only inside the DM of an account that
 * already owns the record, so being able to quote it back is evidence of
 * controlling that account. That is only sound with all four of these, which is why
 * none of them is optional:
 *
 *   1. Minted only in an already-authenticated context (the calling gateway's job).
 *   2. Short-lived and single-use — 5 minutes, burnt on redemption.
 *   3. Rate-limited, so the space cannot be swept.
 *   4. Announced back on the origin channel, so a social-engineered code still
 *      surfaces to the real owner (`notifyOtherAccounts`, called by the command layer).
 *
 * And one rule that lives outside this file: a code is only ever read from a slash
 * command argument. It must never be reachable from model output, tool results or
 * fetched data, or a prompt injection could link an attacker's account.
 *
 * See `MULTI-CHANNEL.md` §1.
 */

/**
 * No 0/O, 1/I/L, or U — a code gets read off one screen and typed into another, so
 * the character set is chosen for transcription, not for density. 30^8 ≈ 6.5e11
 * combinations against a 5-minute window and 5 attempts an hour.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

export const CODE_TTL_MS = 5 * 60 * 1000;
export const MINTS_PER_HOUR = 3;
export const REDEEM_ATTEMPTS_PER_HOUR = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

export interface MintedCode {
  /** Shown to the user, formatted `WARD-XXXX-XXXX`. Never persisted. */
  code: string;
  expiresAt: Date;
}

export type RedeemFailure =
  | "malformed"
  | "unknown"
  | "expired"
  | "already_used"
  | "rate_limited"
  | "belongs_to_other_principal";

export type RedeemResult =
  | { ok: true; userId: string; mintedOn: Channel; rebound: boolean }
  | { ok: false; reason: RedeemFailure; message: string };

// --- code shape ---

function randomCode(): string {
  let out = "";
  // randomInt is rejection-sampled, so a 30-character alphabet stays uniform —
  // `randomBytes % 30` would not be.
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** `WARD-ABCD-EFGH` — the form the user sees. */
export function formatCode(raw: string): string {
  return `WARD-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Accept what a human actually types: any case, any separators, with or without the
 * `WARD` prefix. Returns `null` when the result isn't a well-formed code.
 */
export function normalizeCode(input: string): string | null {
  const upper = input.toUpperCase();
  const stripped = upper.startsWith("WARD") ? upper.slice(4) : upper;
  const chars = [...stripped].filter((c) => ALPHABET.includes(c)).join("");
  return chars.length === CODE_LENGTH ? chars : null;
}

function hashCode(normalized: string): string {
  return createHash("sha256").update(`ward-link:${normalized}`).digest("hex");
}

// --- rate limiting ---

async function hitRateLimit(scope: string, limit: number, now: Date): Promise<boolean> {
  const cutoff = now.getTime() - RATE_WINDOW_MS;
  const recent = (await readRateWindow(scope)).filter((ts) => Date.parse(ts) > cutoff);
  if (recent.length >= limit) {
    await writeRateWindow(scope, recent);
    return true;
  }
  await writeRateWindow(scope, [...recent, now.toISOString()]);
  return false;
}

const mintScope = (userId: string) => `mint.${userId}`;

/**
 * Spend one mint from this user's hourly allowance. Shared with MCP token issuing,
 * so a caller cannot dodge the limit by asking for a different kind of credential.
 */
export async function consumeMintAllowance(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return !(await hitRateLimit(mintScope(userId), MINTS_PER_HOUR, now));
}
const redeemScope = (channel: Channel, accountId: string) => `redeem.${channel}_${accountId}`;

// --- mint ---

export class RateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimited";
  }
}

/**
 * Mint a code for `userId`. The caller must already have established that the
 * requester controls an account belonging to that principal — this function trusts
 * its argument, which is why it is only ever reached from an authenticated DM.
 */
export async function mintLinkCode(
  userId: string,
  mintedOn: Channel,
  now: Date = new Date(),
): Promise<MintedCode> {
  if (await hitRateLimit(mintScope(userId), MINTS_PER_HOUR, now)) {
    throw new RateLimited(
      `You've asked for ${MINTS_PER_HOUR} link codes in the last hour — try again later.`,
    );
  }

  const raw = randomCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await writeLinkCode(hashCode(raw), {
    ward_user_id: userId,
    minted_on: mintedOn,
    minted_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    used_at: null,
    used_by: null,
  });

  return { code: formatCode(raw), expiresAt };
}

// --- redeem ---

/**
 * Redeem a code, attaching `channel`/`accountId` to the principal that minted it.
 *
 * The interesting case is an account that already resolves to a *different*
 * principal. Usually that principal is an empty shell — someone said "hi" on Discord
 * before linking, which minted one — and rebinding it loses nothing. But once it has
 * an authorization record or a wallet, rebinding would silently merge two spend
 * ledgers and two revocation logs into one, so it is refused outright. `rebound` says
 * which of the two happened.
 */
export async function redeemLinkCode(
  input: string,
  channel: Channel,
  accountId: string,
  now: Date = new Date(),
): Promise<RedeemResult> {
  if (await hitRateLimit(redeemScope(channel, accountId), REDEEM_ATTEMPTS_PER_HOUR, now)) {
    return {
      ok: false,
      reason: "rate_limited",
      message: `Too many link attempts from this account. Try again in an hour.`,
    };
  }

  const normalized = normalizeCode(input);
  if (normalized === null) {
    return {
      ok: false,
      reason: "malformed",
      message: "That doesn't look like a link code. They look like WARD-ABCD-EFGH.",
    };
  }

  const hash = hashCode(normalized);
  const record = await readLinkCode(hash);
  if (record === null) {
    return { ok: false, reason: "unknown", message: "I don't know that code." };
  }
  if (record.used_at !== null) {
    return {
      ok: false,
      reason: "already_used",
      message: "That code has already been used. Link codes work exactly once — mint a new one.",
    };
  }
  if (Date.parse(record.expires_at) <= now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      message: "That code has expired. Mint a fresh one with /link and use it within 5 minutes.",
    };
  }

  const current = await resolveExisting(channel, accountId);
  let rebound = false;
  if (current !== null && current !== record.ward_user_id) {
    const [existingAuth, existingWallet] = await Promise.all([
      read(current).catch(() => null),
      readWallet(current).catch(() => null),
    ]);
    if (existingAuth !== null || existingWallet !== null) {
      return {
        ok: false,
        reason: "belongs_to_other_principal",
        message:
          "This account already has its own Ward authorization — with its own limits and " +
          "spend history. I won't merge two records into one. Delete this account's " +
          "authorization first if you meant to move it.",
      };
    }
    rebound = true; // an empty shell principal; nothing to lose
  }

  // Burn first. A crash after this point costs the user a code, which they can mint
  // again; burning after the link would leave a live code that already worked.
  await writeLinkCode(hash, {
    ...record,
    used_at: now.toISOString(),
    used_by: `${channel}:${accountId}`,
  });

  if (rebound) {
    // Detach the empty shell so `link` sees an unclaimed account. This uses the
    // store's `forgetIdentity` rather than `unlink`, which would refuse to remove a
    // principal's last account — here that refusal is exactly wrong, since the
    // principal being emptied has nothing worth keeping a route to.
    await forgetIdentity(current!, channel, accountId);
    await appendJournalEvent(
      current!,
      "identity_unlink",
      `released ${channel}:${accountId} to ${record.ward_user_id} (empty principal)`,
      { channel, account_id: accountId, released_to: record.ward_user_id },
      channel,
    );
  }

  await link(record.ward_user_id, channel, accountId, "link_code");

  return { ok: true, userId: record.ward_user_id, mintedOn: record.minted_on, rebound };
}

/** Every account attached to `userId` except the one that just acted. */
export async function otherAccounts(
  userId: string,
  exceptChannel: Channel,
  exceptAccountId: string,
): Promise<Array<{ channel: Channel; account_id: string }>> {
  const accounts = await accountsFor(userId);
  return accounts.filter((a) => !(a.channel === exceptChannel && a.account_id === exceptAccountId));
}
