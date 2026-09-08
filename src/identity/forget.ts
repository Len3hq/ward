import { createHash, randomBytes } from "node:crypto";

import {
  appendJournalEvent,
  forgetAuthorization,
  forgetConversation,
  read,
  readConversation,
  readLinkCode,
  readWallet,
  writeLinkCode,
  type Channel,
} from "../../memory/index.ts";
import { notifyAccount } from "../gateway/channels.ts";
// Type-only, so it is erased at compile time and cannot create a runtime cycle.
import type { CommandContext } from "./commands.ts";
import { accountsFor, resolveUser } from "./index.ts";
import { consumeForgetAllowance, otherAccounts } from "./linking.ts";

/**
 * `/forget_me` — the deletion gate, moved from an operator script to the user
 * (Phase 17).
 *
 * Ward's whole claim is that its authority lives in a memory record rather than in
 * its code: delete the record and it refuses to act, even where the chain would
 * still permit the spend. Until this command that property was real but only an
 * operator could exercise it, over `railway ssh`. A user who wanted their Ward's
 * authority gone had no way to ask for it.
 *
 * **Why handing this to users is safe**, when handing them `grant` would not be:
 *
 * - It only ever *removes* authority. There is no wording of this command that lets
 *   Ward do more, so the worst outcome of a spurious one is an agent that refuses
 *   until the user re-onboards — thirty seconds, and onto the same wallet (§4 below).
 * - It cannot be triggered by injected text. Like `/link` and `/unlink` it is read
 *   off the slash-command text and routed outside the graph, so no tool result,
 *   fetched document or model output can reach it.
 * - It is two steps and principal-bound: a readback plus a single-use code, held as
 *   digest-keyed HOT state with a 5-minute TTL, unusable by any other principal.
 * - It announces itself to every other linked account, so a hijacked session cannot
 *   quietly wipe someone's policy without their other apps lighting up.
 *
 * **MCP is excluded.** A bearer token out of a config file is a process, not a
 * person, and must not be able to delete a Ward — the same rule that stops it
 * minting its own access or granting itself authority.
 *
 * What survives, and why, is PHASE-17.md §2 and §4. The short version: the wallet
 * record stays, because `account_key` is what the smart-account address is derived
 * from, and the channel links stay, because losing them would mint a fresh principal
 * and strand the user's funds at an address nothing points to any more.
 */

/** How long a proposed deletion waits for its confirmation. Matches `/mcp_confirm`. */
export const FORGET_TTL_MS = 5 * 60 * 1000;

/**
 * Its own digest namespace, so a code minted for a deletion can never be redeemed as
 * a link code or a grant confirmation, or the other way round.
 */
function pendingKey(code: string): string {
  return createHash("sha256").update(`ward-forget:${code.toUpperCase()}`).digest("hex");
}

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function confirmCode(): string {
  return [...randomBytes(6)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/** What a typed argument has to look like to be treated as a confirmation code. */
const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{6}$`, "i");

export type ForgetResult = { ok: true } | { ok: false; message: string };

/**
 * Stage a deletion. Returns the code the user has to send back.
 *
 * Nothing is deleted here and nothing is reserved — `confirmForget` re-reads the
 * record, so a user who changes their mind can simply not send the second message.
 */
export async function proposeForget(
  userId: string,
  channel: Channel,
  now: Date = new Date(),
): Promise<{ code: string }> {
  const code = confirmCode();
  await writeLinkCode(pendingKey(code), {
    ward_user_id: userId,
    minted_on: channel,
    minted_by: null,
    minted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + FORGET_TTL_MS).toISOString(),
    used_at: null,
    used_by: null,
  });
  return { code };
}

/**
 * Apply a staged deletion.
 *
 * Order matters: the journal event is written **before** the delete, so the audit
 * trail records the deletion itself even if the process dies mid-way. The COLD
 * journal is deliberately kept — it is the narrative of the user's own actions, it
 * never reaches the critical path or a prompt, and keeping it is what makes "when
 * did I delete my Ward?" answerable.
 */
export async function confirmForget(
  code: string,
  userId: string,
  channel: Channel,
  now: Date = new Date(),
): Promise<ForgetResult> {
  const typed = code.trim();
  // Every rejection below says the same thing. Telling a prober which guess was
  // structurally valid, which was expired and which belonged to somebody else would
  // hand them the shape of the space for free.
  const opaque = { ok: false, message: "I don't know that confirmation code." } as const;
  if (!CODE_SHAPE.test(typed)) return opaque;

  const key = pendingKey(typed);
  const pending = await readLinkCode(key);
  if (pending === null) return opaque;
  if (pending.used_at !== null) return opaque;
  if (Date.parse(pending.expires_at) <= now.getTime()) {
    return { ok: false, message: "That confirmation expired. Send /forget_me again." };
  }
  // A code shown in one principal's DM must not be usable by another.
  if (pending.ward_user_id !== userId) return opaque;

  // Burn first, as everywhere else in Ward: a crash after this costs the user a
  // confirmation they can redo, where the other order leaves a live code that has
  // already worked once.
  await writeLinkCode(key, { ...pending, used_at: now.toISOString(), used_by: userId });

  await appendJournalEvent(
    userId,
    "authorization_forgotten",
    `authorization deleted by the user from ${channel}`,
    { channel },
    channel,
  );

  await forgetAuthorization(userId, "user requested deletion (/forget_me)");
  await forgetConversation(userId);

  return { ok: true };
}

/**
 * `/forget_me` — no argument proposes, a code applies. The same shape as `/link`,
 * so there is no new command grammar to learn.
 */
export async function forgetMeCommand(ctx: CommandContext, argument: string): Promise<string> {
  if (ctx.channel === "mcp") {
    return (
      "An MCP client can't delete your Ward. Ask for this from Telegram or Discord, " +
      "where I know a person is asking."
    );
  }

  const { userId } = await resolveUser(ctx.channel, ctx.accountId);
  const typed = argument.trim();
  return typed.length > 0 ? apply(ctx, userId, typed) : propose(ctx, userId);
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The readback: exactly what goes, exactly what stays, and the code to send back. */
async function propose(ctx: CommandContext, userId: string): Promise<string> {
  const record = await read(userId);
  if (record === null) {
    return [
      "There's no authorization on file for you, so there's nothing to delete.",
      "",
      'I already refuse to move money for you. Say "set me up" if you want to change that.',
    ].join("\n");
  }

  if (!(await consumeForgetAllowance(userId))) {
    return "You've asked to delete your authorization several times in the last hour. Try again later.";
  }

  const { code } = await proposeForget(userId, ctx.channel);
  const [wallet, accounts, summary] = await Promise.all([
    readWallet(userId),
    accountsFor(userId),
    readConversation(userId),
  ]);
  const spends = record.spent_ledger.length;
  const pauses = record.revocation_log.length;
  const jobs = record.acp_job_history.length;

  // Only what this user actually has. A readback that solemnly offers to delete "0
  // pauses" and "0 jobs" is padding, and padding is what people skim past — which is
  // the one thing a confirmation must not invite.
  const going = [
    `  · your limits — $${record.standing_caps.per_action_limit_usd} per action, ` +
      `$${record.standing_caps.daily_limit_usd} per day (${record.risk_label})`,
    ...(spends > 0
      ? [`  · your spend history — ${spends} ${plural(spends, "entry", "entries")}`]
      : []),
    ...(pauses > 0 ? [`  · ${pauses} ${plural(pauses, "pause", "pauses")} you've set`] : []),
    ...(jobs > 0
      ? [`  · what I've learned about counterparties — ${jobs} ${plural(jobs, "job", "jobs")}`]
      : []),
    ...(summary === null ? [] : ["  · our conversation summary"]),
  ];

  return [
    "This deletes the authorization record I act under — everything I know about what",
    "I'm allowed to do for you:",
    "",
    ...going,
    "",
    "After that I refuse every action, on every app, until you set new limits — even",
    "where your on-chain allowance would still let me spend.",
    "",
    "What I keep:",
    wallet === null
      ? "  · your linked accounts, so you can still reach me"
      : "  · your wallet and its address, so re-onboarding puts you back on the same funds",
    ...(wallet === null ? [] : ["  · your linked accounts, so you can still reach me"]),
    "  · the journal of what you did and when, including this deletion",
    ...(wallet?.spend_permission?.status === "active"
      ? [
          "",
          "Your on-chain spend permission stays live — deleting memory doesn't touch the",
          'chain. Say "revoke my permission" if you want that gone too.',
        ]
      : []),
    ...(accounts.length > 1
      ? ["", `I'll tell your other ${accounts.length - 1} linked account(s) that this happened.`]
      : []),
    "",
    `To go ahead, send: /forget_me ${code}`,
    "If that isn't what you meant, do nothing — it expires in 5 minutes.",
  ].join("\n");
}

/** Apply a code, then tell every other account it happened. */
async function apply(ctx: CommandContext, userId: string, code: string): Promise<string> {
  const had = (await readConversation(userId)) !== null;
  const result = await confirmForget(code, userId, ctx.channel);
  if (!result.ok) return result.message;

  const others = await otherAccounts(userId, ctx.channel, ctx.accountId);
  const announcement =
    `Your Ward authorization was just deleted from ${ctx.channel}. ` +
    "Your limits, spend history and counterparty trust are gone, and I won't move money " +
    "on any app until you set new limits.\n\n" +
    'If that wasn\'t you, say "set me up" to put limits back — and check who else can ' +
    "reach your Ward with /whoami.";

  const unreached: string[] = [];
  for (const account of others) {
    // Best effort, like a link announcement: a send failure must never unwind a
    // deletion that has already happened.
    const delivered = await notifyAccount(account.channel, account.account_id, announcement);
    if (!delivered) unreached.push(account.channel);
  }

  return [
    "Deleted. I have no authorization on file for you any more, so I won't move any " +
      "funds — not even where the chain would still allow it.",
    had ? "Our conversation summary is gone too." : "",
    "",
    others.length === 0
      ? ""
      : unreached.length > 0
        ? `Heads up: I couldn't reach your ${unreached.join(", ")} account to announce this.`
        : "I've told your other linked accounts, so you'd know if this wasn't you.",
    'Say "set me up" whenever you want to start again — your wallet and its balance are',
    "untouched, and new limits put you back on the same address.",
    "",
    "/newsession clears what's left in this chat.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n")
    .trim();
}
