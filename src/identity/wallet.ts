import { verifyMessage } from "viem";

import {
  appendJournalEvent,
  forgetOwner,
  readOwner,
  readOwners,
  writeOwner,
  type Channel,
  type VerifiedOwner,
} from "../../memory/index.ts";
import { burnLinkState, canClaim, claimAccount, readLinkState } from "./linking.ts";

/**
 * Wallet-signature linking (Phase 14) — proving control of an address, and using
 * that proof to attach a channel account to a principal.
 *
 * ## What this deliberately does NOT do
 *
 * The original plan was "sign a nonce with the smart account in `ward.wallet`".
 * That is not sound in Ward's custody model: the smart account and its owner are
 * both **CDP-managed**, so Ward can produce a valid signature from that address at
 * any time, for anybody. A signature from it proves nothing about the human sitting
 * in front of the browser.
 *
 * So what is proved here is control of an address the **user** holds — an EOA in
 * their own wallet — which is a real credential precisely because Ward cannot
 * produce it. The address is an identity, not a source of funds; Ward's money still
 * lives in the CDP smart account and moves only within the Spend Permission.
 *
 * ## Why it is worth having anyway
 *
 * A link code can only be minted from a chat account you still control. Lose the
 * Telegram account and there is no route back to the principal — the record is
 * intact and unreachable. A proved address is the recovery path: `ward.owner`
 * resolves a principal from a signature alone.
 *
 * ## Trust on first use, and its ceiling
 *
 * The first address a principal proves is *enrolled* — accepted because the state
 * behind it was minted inside an already-authenticated DM, which is the same
 * assumption the link code rests on. After that, a signature must match an address
 * already on file. So this is exactly as strong as the DM it was set up from, and no
 * stronger; it does not upgrade a compromised chat account into a secure one.
 */

/** What the user signs. The state is inside it, so a signature cannot be replayed. */
export function challenge(state: string): string {
  return [
    "Ward — prove you control this wallet.",
    "",
    "Signing this links this wallet to your Ward. It moves no funds and grants no",
    "spending authority: Ward can only ever spend within the on-chain Spend",
    "Permission you granted separately, and only up to the limits in its memory.",
    "",
    `Challenge: ${state}`,
  ].join("\n");
}

export type WalletLinkResult =
  | {
      ok: true;
      userId: string;
      address: string;
      enrolled: boolean;
      mintedOn: Channel;
      accountId: string | null;
    }
  | { ok: false; message: string };

/**
 * Verify a signature over `challenge(state)` and attach the account that asked for
 * the state to whichever principal owns the address.
 *
 * The state is read but not spent until the signature checks out — a fumbled signing
 * prompt should cost nothing. Everything else about it is a link code: same TTL,
 * same single use, same refusal to merge two funded principals, because the claim
 * goes through the same `canClaim` / `claimAccount` the code path uses.
 */
export async function redeemWalletSignature(
  state: string,
  address: string,
  signature: string,
  now: Date = new Date(),
): Promise<WalletLinkResult> {
  const record = await readLinkState(state, now);
  if (record === null) {
    return {
      ok: false,
      message: "That link has expired or was already used. Ask for a fresh one.",
    };
  }

  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message: challenge(state),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, message: "That signature doesn't match that address." };

  const normalized = address.toLowerCase();
  const mintedFor = record.ward_user_id;
  const channel = record.minted_on;
  const accountId = record.minted_by;

  const existing = await readOwner(normalized);

  // Enrollment is trust-on-first-use, and only for a principal with no owner yet —
  // so a stranger's signature can never quietly become a second owner of someone's
  // Ward, and an address already bound elsewhere is never silently moved.
  let target: string;
  let enrolled = false;
  if (existing === null) {
    if ((await readOwners(mintedFor)).length > 0) {
      return {
        ok: false,
        message:
          "That wallet isn't on file for this Ward. Sign with one you've already verified, " +
          "or link from a chat account you still control.",
      };
    }
    target = mintedFor;
    enrolled = true;
  } else {
    // The recovery case: the address decides the principal, not the state.
    target = existing.ward_user_id;
  }

  // The account to attach is the one that asked for the link. A state minted before
  // Phase 14 (or over MCP) carries none — the signature is still verified and the
  // owner still enrolled, there is simply no channel account to move.
  let claim: { ok: true; rebound: boolean } | { ok: false; message: string } = {
    ok: true,
    rebound: false,
  };
  if (accountId !== null) {
    const claimable = await canClaim(target, channel, accountId);
    claim = claimable.ok ? claimable : { ok: false, message: claimable.message };
    if (!claim.ok) return claim;
  }

  await burnLinkState(state, `wallet:${normalized}`, now);

  if (enrolled) {
    await writeOwner(target, normalized);
    await appendJournalEvent(
      target,
      "owner_verified",
      `verified wallet ${normalized}`,
      { address: normalized, enrolled: true },
      channel,
    );
  }

  if (accountId !== null && claim.ok) {
    await claimAccount(target, channel, accountId, "wallet_signature", claim.rebound);
  }

  return {
    ok: true,
    userId: target,
    address: normalized,
    enrolled,
    mintedOn: channel,
    accountId,
  };
}

/** Every address this principal has proved. */
export async function ownersFor(userId: string): Promise<VerifiedOwner["address"][]> {
  return (await readOwners(userId)).map((o) => o.address);
}

/** Drop a proved address. The authorization record is untouched. */
export async function revokeOwner(
  userId: string,
  address: string,
  channel: Channel,
): Promise<boolean> {
  const normalized = address.toLowerCase();
  const owners = await readOwners(userId);
  if (!owners.some((o) => o.address === normalized)) return false;

  await forgetOwner(userId, normalized);
  await appendJournalEvent(
    userId,
    "owner_revoked",
    `revoked wallet ${normalized}`,
    { address: normalized },
    channel,
  );
  return true;
}
