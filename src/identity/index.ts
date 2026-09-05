import {
  appendJournalEvent,
  forgetIdentity,
  readAccounts,
  readIdentity,
  writeIdentity,
  accountIdSchema,
  channelSchema,
  WARD_USER_ID_RE,
  type Channel,
  type LinkedAccount,
  type LinkMethod,
  type WardIdentity,
} from "../../memory/index.ts";
import { ulid } from "./ulid.ts";

/**
 * Who is talking to Ward.
 *
 * Ward does **not** recognise a person across channels — nothing in a conversation
 * proves that a Discord account and a Telegram account are the same human, and
 * treating writing style or a mentioned wallet as proof is an impersonation vector.
 * Ward is *told*, once, by a proof only the account owner can produce (Phase 10's
 * link code), and thereafter performs the table lookup in this module.
 *
 * The table is two Sibyl Memory entities, both written by `memory/store.ts`:
 *
 *   ward.identity / <channel>:<account_id>   → the principal that account belongs to
 *   ward.accounts / <ward_user_id>           → every account that principal owns
 *
 * Everything downstream — the authorization record, the wallet, the episodic
 * summary — is keyed by the principal alone, so a user's caps, ledger and
 * revocations are the same object whichever surface they arrive from.
 *
 * See `MULTI-CHANNEL.md`.
 */

export type { Channel, LinkedAccount, WardIdentity };
export { ulid };

/** A resolved principal, plus how the caller got here. */
export interface ResolvedUser {
  userId: string;
  channel: Channel;
  accountId: string;
  /** True when this call minted the principal — the caller is brand new to Ward. */
  created: boolean;
}

/** `ward_` + a 26-char ULID. Non-numeric by design — see `wardUserIdSchema`. */
export function mintWardUserId(): string {
  return `ward_${ulid()}`;
}

export function isWardUserId(value: string): boolean {
  return WARD_USER_ID_RE.test(value);
}

/**
 * Map an inbound channel account to its principal, minting one on first contact.
 *
 * `first_contact` is only sound for a channel where the account itself is the
 * proof of identity — a Telegram or Discord DM. It must never be used for MCP,
 * whose caller is a local process holding a token and has no identity of its own;
 * `resolveToken` handles that case and refuses to mint.
 */
export async function resolveUser(channel: Channel, accountId: string): Promise<ResolvedUser> {
  const ch = channelSchema.parse(channel);
  const account = accountIdSchema.parse(accountId);

  const existing = await readIdentity(ch, account);
  if (existing) {
    return { userId: existing.ward_user_id, channel: ch, accountId: account, created: false };
  }

  if (ch === "mcp") {
    throw new Error(
      "an MCP client cannot mint a principal — it must present a token minted by /link on a human channel",
    );
  }

  const userId = mintWardUserId();
  await link(userId, ch, account, "first_contact");
  return { userId, channel: ch, accountId: account, created: true };
}

/**
 * Resolve a channel account without creating anything. `null` when unknown — the
 * answer an MCP client with an unrecognised token gets.
 */
export async function resolveExisting(channel: Channel, accountId: string): Promise<string | null> {
  const identity = await readIdentity(
    channelSchema.parse(channel),
    accountIdSchema.parse(accountId),
  );
  return identity?.ward_user_id ?? null;
}

/**
 * Attach a channel account to an existing principal.
 *
 * Refuses to move an account that already belongs to a *different* principal. That
 * is a merge, and merging two authorization records means merging two spend
 * ledgers and two revocation logs — never something to do silently. The caller is
 * told to unlink first.
 */
export async function link(
  userId: string,
  channel: Channel,
  accountId: string,
  via: LinkMethod,
): Promise<WardIdentity> {
  const ch = channelSchema.parse(channel);
  const account = accountIdSchema.parse(accountId);

  const existing = await readIdentity(ch, account);
  if (existing && existing.ward_user_id !== userId) {
    throw new Error(
      `${ch}:${account} is already linked to a different Ward user — unlink it there first`,
    );
  }

  const identity = await writeIdentity(userId, ch, account, via);
  await appendJournalEvent(
    userId,
    "identity_link",
    `linked ${ch}:${account} via ${via}`,
    { channel: ch, account_id: account, linked_via: via },
    ch,
  );
  return identity;
}

/**
 * Detach a channel account. The authorization record is deliberately untouched:
 * unlinking is "this app can no longer reach my Ward", not "forget me" — that is
 * what deleting the entity does, and the gate refuses on its own once it's gone.
 *
 * Refuses to remove the last account, which would orphan the record with no way
 * back to it.
 */
export async function unlink(userId: string, channel: Channel, accountId: string): Promise<void> {
  const ch = channelSchema.parse(channel);
  const account = accountIdSchema.parse(accountId);

  const accounts = await readAccounts(userId);
  if (!accounts.some((a) => a.channel === ch && a.account_id === account)) {
    throw new Error(`${ch}:${account} is not linked to this Ward user`);
  }
  if (accounts.length === 1) {
    throw new Error(
      "that is your only linked account — unlinking it would leave your authorization record unreachable",
    );
  }

  await forgetIdentity(userId, ch, account);
  await appendJournalEvent(
    userId,
    "identity_unlink",
    `unlinked ${ch}:${account}`,
    { channel: ch, account_id: account },
    ch,
  );
}

/**
 * Detach every account on one channel at once, and return how many went.
 *
 * This is for credentials rather than chat accounts: "revoke my MCP access" must not
 * leave a second token the user forgot they minted still working. It keeps the same
 * guarantee as `unlink` — it will not remove the principal's last remaining account,
 * which would leave the authorization record unreachable.
 */
export async function unlinkAll(userId: string, channel: Channel): Promise<number> {
  const ch = channelSchema.parse(channel);
  const accounts = await readAccounts(userId);
  const doomed = accounts.filter((a) => a.channel === ch);
  if (doomed.length === 0) return 0;
  if (doomed.length === accounts.length) {
    throw new Error(
      `those are your only linked accounts — removing them would leave your ` +
        `authorization record unreachable`,
    );
  }

  for (const account of doomed) {
    await forgetIdentity(userId, ch, account.account_id);
  }
  await appendJournalEvent(
    userId,
    "identity_unlink",
    `unlinked ${doomed.length} ${ch} account(s)`,
    { channel: ch, count: doomed.length },
    ch,
  );
  return doomed.length;
}

/** Every channel account this principal owns — for `/whoami` and link notifications. */
export async function accountsFor(userId: string): Promise<LinkedAccount[]> {
  return readAccounts(userId);
}

/**
 * Parse a `<channel>:<account_id>` reference, as operator scripts accept it. Returns
 * `null` for anything that isn't one, so a caller can fall back to treating the
 * argument as a principal.
 */
export function parseAccountRef(ref: string): { channel: Channel; accountId: string } | null {
  const at = ref.indexOf(":");
  if (at <= 0) return null;
  const channel = channelSchema.safeParse(ref.slice(0, at));
  const accountId = accountIdSchema.safeParse(ref.slice(at + 1));
  if (!channel.success || !accountId.success) return null;
  return { channel: channel.data, accountId: accountId.data };
}

/**
 * Operator convenience: accept either a `WardUserId` or a `<channel>:<account_id>`
 * reference and return the principal. Used by `scripts/forget-auth.ts`, so the
 * judges' deletion command works with a Telegram id as well as a Ward id.
 */
export async function resolveRef(ref: string): Promise<string | null> {
  if (isWardUserId(ref)) return ref;
  const parsed = parseAccountRef(ref);
  if (!parsed) return null;
  return resolveExisting(parsed.channel, parsed.accountId);
}
