import { channelSchema, type Channel } from "../../memory/index.ts";
import { notifyAccount } from "../gateway/channels.ts";
import { issueToken, revokeAllTokens, tokenCount } from "../mcp/token.ts";
import { accountsFor, resolveUser, unlink } from "./index.ts";
import {
  CODE_TTL_MS,
  consumeMintAllowance,
  mintLinkCode,
  otherAccounts,
  RateLimited,
  redeemLinkCode,
} from "./linking.ts";

/**
 * `/link`, `/unlink` and `/whoami`, written once for every channel. The Telegram
 * gateway wires them up in Phase 10; the Discord gateway calls the same functions in
 * Phase 11 without re-implementing any of the policy.
 *
 * **These run before the guard and never touch the graph.** A link code is read from
 * a slash-command argument and nowhere else, so no amount of injected text in a
 * conversation, a tool result or a fetched document can cause an account to be
 * linked. That is a security property, not a layering preference — keep it that way
 * when adding a channel.
 */

export interface CommandContext {
  channel: Channel;
  /** The channel's own id for the account that sent the command. */
  accountId: string;
}

const MINUTES = Math.round(CODE_TTL_MS / 60000);

/**
 * `/link` — no argument mints a code for another chat app; `mcp` mints a bearer
 * token for an MCP client; anything else is treated as a code to redeem.
 *
 * `mcp` cannot collide with a real code: codes are eight characters, so "mcp"
 * never normalizes to one. It is still matched first, so the check does not depend
 * on that.
 */
export async function linkCommand(ctx: CommandContext, argument: string): Promise<string> {
  const arg = argument.trim();
  if (arg.toLowerCase() === "mcp") return mintMcpToken(ctx);
  return arg.length > 0 ? redeem(ctx, arg) : mint(ctx);
}

/**
 * Mint an MCP bearer token. Unlike a link code this is long-lived, so the reply is
 * blunt about what it is and what it deliberately cannot do.
 */
async function mintMcpToken(ctx: CommandContext): Promise<string> {
  if (ctx.channel === "mcp") {
    return "An MCP client can't mint its own access. Ask for this from Telegram or Discord.";
  }

  const { userId } = await resolveUser(ctx.channel, ctx.accountId);
  if (!(await consumeMintAllowance(userId))) {
    return "You've minted too many credentials in the last hour — try again later.";
  }

  const token = await issueToken(userId);
  const existing = await tokenCount(userId);

  return [
    "Add this to your MCP client config:",
    "",
    `    WARD_USER_TOKEN=${token}`,
    "",
    "I won't show it again — mint another if you lose it.",
    "",
    "That client can read your limits, your spend history and your wallet, and it can " +
      "*propose* a spend. It cannot approve one: every proposal comes back here for you " +
      "to confirm. So a leaked token can't move your money.",
    existing > 1 ? `\nYou now have ${existing} MCP tokens. "/unlink mcp" revokes all of them.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function mint(ctx: CommandContext): Promise<string> {
  const { userId } = await resolveUser(ctx.channel, ctx.accountId);
  try {
    const { code } = await mintLinkCode(userId, ctx.channel);
    return [
      `Your link code is ${code}`,
      "",
      `Send "/link ${code}" from the other app within ${MINUTES} minutes and it will reach ` +
        `this same Ward — same limits, same spend history, same wallet.`,
      "",
      "It works once. Don't paste it anywhere but the app you're linking.",
    ].join("\n");
  } catch (error) {
    if (error instanceof RateLimited) return error.message;
    throw error;
  }
}

async function redeem(ctx: CommandContext, code: string): Promise<string> {
  const result = await redeemLinkCode(code, ctx.channel, ctx.accountId);
  if (!result.ok) return result.message;

  // The phishing backstop: tell every other account this just happened.
  const others = await otherAccounts(result.userId, ctx.channel, ctx.accountId);
  const announcement =
    `A ${ctx.channel} account (${ctx.accountId}) was just linked to your Ward. ` +
    `It can now see your limits and spend history, and act within them.\n\n` +
    `If that wasn't you, send "/unlink ${ctx.channel}" right now.`;

  const unreached: string[] = [];
  for (const account of others) {
    const delivered = await notifyAccount(account.channel, account.account_id, announcement);
    if (!delivered) unreached.push(account.channel);
  }

  return [
    `Linked. This ${ctx.channel} account now reaches the Ward you set up on ${result.mintedOn}.`,
    result.rebound
      ? "(This account had an empty Ward with no authorization on it — nothing was lost.)"
      : "",
    unreached.length > 0
      ? `Heads up: I couldn't reach your ${unreached.join(", ")} account to announce this.`
      : "I've told your other linked accounts, so you'd know if this wasn't you.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** `/unlink <channel>` — detach one channel from this principal. */
export async function unlinkCommand(ctx: CommandContext, argument: string): Promise<string> {
  const { userId } = await resolveUser(ctx.channel, ctx.accountId);
  const accounts = await accountsFor(userId);

  const target = channelSchema.safeParse(argument.trim().toLowerCase());
  if (!target.success) {
    const linked = accounts.map((a) => a.channel).join(", ") || "none";
    return `Which one? Say "/unlink <channel>". You currently have: ${linked}.`;
  }

  // MCP tokens go all at once: "revoke my MCP access" must not leave a second
  // token the user forgot they minted still working.
  if (target.data === "mcp") {
    try {
      const revoked = await revokeAllTokens(userId);
      if (revoked === 0) return "You have no MCP tokens.";
      return (
        `Revoked ${revoked} MCP token${revoked === 1 ? "" : "s"}. Any client using one now ` +
        `gets nothing.\n\nYour authorization in Sibyl Memory is unchanged.`
      );
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  const match = accounts.find((a) => a.channel === target.data);
  if (!match) return `You have no ${target.data} account linked.`;

  try {
    await unlink(userId, match.channel, match.account_id);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const note =
    match.channel === ctx.channel
      ? "That was this account — I won't recognise you here any more."
      : "It can no longer see your limits or act on your behalf.";
  return `Unlinked ${match.channel}. ${note}\n\nYour authorization in Sibyl Memory is unchanged.`;
}

/** `/whoami` — the principal and every account attached to it. */
export async function whoamiCommand(ctx: CommandContext): Promise<string> {
  const { userId } = await resolveUser(ctx.channel, ctx.accountId);
  const accounts = await accountsFor(userId);

  const lines = accounts
    .slice()
    .sort((a, b) => a.linked_at.localeCompare(b.linked_at))
    .map((a) => {
      const here =
        a.channel === ctx.channel && a.account_id === ctx.accountId ? "  ← you are here" : "";
      // Report how it was actually attached, not how its position implies — a
      // migrated account is the oldest one and is not "first contact".
      return `· ${a.channel}:${a.account_id} (${a.linked_via.replace(/_/g, " ")})${here}`;
    });

  return [
    `You are ${userId}.`,
    "",
    accounts.length > 1 ? "Linked accounts:" : "Linked account:",
    ...lines,
    "",
    "All of them share one authorization record — one set of limits, one daily cap, " +
      "one spend history. Add another with /link.",
  ].join("\n");
}
