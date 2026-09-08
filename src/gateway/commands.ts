import { linkCommand, mcpCommand, unlinkCommand, whoamiCommand } from "../identity/commands.ts";
import type { CommandContext } from "../identity/commands.ts";

/**
 * Every slash command Ward answers to, written once for both gateways.
 *
 * This table exists because a subcommand cannot be discovered. Telegram's menu and
 * Discord's autocomplete list *command names*, and a name is one word — so `/link mcp`
 * and `/mcp grant`, the two commands that connect a coding client and decide what it
 * may spend, appeared nowhere a user could find them. You had to already know the
 * second word to type it, and the only place the second words were written down was
 * the output of a command you had no reason to run.
 *
 * So every subcommand also gets an underscore name. `/link_mcp` is `/link mcp`, and
 * because it is one word it shows up the moment someone types "/". The spaced forms
 * keep working — everything already sent to a user, and every test, still says them —
 * but the underscore form is what Ward advertises.
 *
 * The other reason it is one table: the menu, the handler registrations and the help
 * text used to be three lists in three files, and nothing made them agree. A command
 * could be advertised and unrouted, or routed and invisible. Here a row is both.
 */

/** The chat apps whose menus this table feeds. */
export type ChatChannel = "telegram" | "discord";

/** What actually runs. The first four are shared identity commands; the rest are the gateway's own. */
export type CommandBase =
  "link" | "mcp" | "unlink" | "whoami" | "help" | "start" | "newsession" | "defaultsession";

export interface CommandSpec {
  /** The word after the slash. Underscores, never spaces. */
  name: string;
  /** Which handler runs. */
  base: CommandBase;
  /** Injected ahead of whatever the user typed: `/mcp_grant a3f9 …` → `mcp("grant a3f9 …")`. */
  argument?: string;
  /**
   * The one line shown in the menu, before anything is clicked. Under 100 characters
   * because Discord refuses longer — Telegram allows 256, and matching the stricter
   * limit keeps one description usable on both.
   */
  description: string;
  /**
   * What to type after the command, if anything. Its presence is what gives Discord an
   * argument box, and its text is what that box says — the old list labelled every one
   * of them "args", which told the user nothing. Absent means the command is complete
   * on its own: `/mcp_stop` takes no argument even though `/mcp` does.
   */
  hint?: string;
  /**
   * Which menus advertise it. Empty means routable but not listed.
   *
   * Advertising and availability are the same thing on Discord and different things on
   * Telegram: Telegraf answers `/mcp_confirm` whether or not `setMyCommands` mentions
   * it, while Discord will not deliver an interaction for a command it never
   * registered. So this field curates Telegram's menu only — Discord registers every
   * row (see `DISCORD_COMMANDS`), because Ward's own replies tell people to send
   * things like "/mcp_confirm ABC123" and that has to work in both apps.
   */
  menu: readonly ChatChannel[];
}

const BOTH: readonly ChatChannel[] = ["telegram", "discord"];
const NONE: readonly ChatChannel[] = [];

/**
 * Order is menu order, and it is the order of a first session: what can I do, who am
 * I, how do I connect something, what may that thing spend, how do I stop it.
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: "help", base: "help", description: "Everything Ward can do", menu: BOTH },
  {
    name: "whoami",
    base: "whoami",
    description: "Which accounts and clients can reach your Ward",
    menu: BOTH,
  },

  // --- connecting something else to this same Ward ---
  {
    name: "link_discord",
    base: "link",
    argument: "discord",
    description: "Use this same Ward from Discord — one click, no code to type",
    menu: ["telegram"],
  },
  {
    name: "link_telegram",
    base: "link",
    argument: "telegram",
    description: "Use this same Ward from Telegram — one click, no code to type",
    menu: ["discord"],
  },
  {
    name: "link_mcp",
    base: "link",
    argument: "mcp",
    description: "Connect Claude Code, Cursor or Zed to your Ward",
    menu: BOTH,
  },
  {
    name: "link_wallet",
    base: "link",
    argument: "wallet",
    description: "Verify a wallet, as a way back in if you lose this account",
    menu: BOTH,
  },
  {
    name: "link_code",
    base: "link",
    description: "Get a code to link another app by hand",
    hint: "Leave empty to mint a code, or paste a code to redeem one",
    menu: BOTH,
  },
  {
    name: "link",
    base: "link",
    description: "Redeem a link code you got from another app",
    hint: "A code from another app, or: discord, telegram, mcp, wallet",
    menu: BOTH,
  },

  // --- what a connected coding client may do ---
  {
    name: "mcp",
    base: "mcp",
    description: "Your connected coding clients, and what each one may spend",
    hint: "tokens, grants, grant, confirm, revoke or stop — or leave it empty",
    menu: BOTH,
  },
  {
    name: "mcp_grant",
    base: "mcp",
    argument: "grant",
    description: "Let one client spend on its own, up to a limit you set",
    hint: "<client> <what> <per action $> <per day $> [days]",
    menu: BOTH,
  },
  {
    name: "mcp_stop",
    base: "mcp",
    argument: "stop",
    description: "Stop every client spending, right now",
    menu: BOTH,
  },
  {
    name: "mcp_tokens",
    base: "mcp",
    argument: "tokens",
    description: "List your connected clients",
    menu: NONE,
  },
  {
    name: "mcp_grants",
    base: "mcp",
    argument: "grants",
    description: "Which clients can spend without asking you",
    menu: NONE,
  },
  {
    name: "mcp_revoke",
    base: "mcp",
    argument: "revoke",
    description: "Take one client's spending permission back",
    hint: "The 8-character client id, from /mcp_tokens",
    menu: NONE,
  },
  {
    name: "mcp_confirm",
    base: "mcp",
    argument: "confirm",
    description: "Apply the grant you were just shown",
    hint: "The confirmation code you were just shown",
    menu: NONE,
  },

  // --- taking things away ---
  {
    name: "unlink",
    base: "unlink",
    description: "Disconnect an app, a wallet, or every coding client",
    hint: "discord, telegram, mcp, or: wallet <address>",
    menu: BOTH,
  },
  {
    name: "unlink_mcp",
    base: "unlink",
    argument: "mcp",
    description: "Disconnect every coding client",
    menu: NONE,
  },
  {
    name: "unlink_wallet",
    base: "unlink",
    argument: "wallet",
    description: "Drop a verified wallet",
    hint: "The wallet address to drop",
    menu: NONE,
  },
  {
    name: "unlink_discord",
    base: "unlink",
    argument: "discord",
    description: "Disconnect Discord",
    menu: NONE,
  },
  {
    name: "unlink_telegram",
    base: "unlink",
    argument: "telegram",
    description: "Disconnect Telegram",
    menu: NONE,
  },

  // --- the conversation itself ---
  {
    name: "newsession",
    base: "newsession",
    description: "Start a fresh conversation (your limits are unchanged)",
    menu: BOTH,
  },
  {
    name: "defaultsession",
    base: "defaultsession",
    description: "Go back to your default conversation",
    menu: BOTH,
  },
  /** Telegram renders its own Start button, so it is routed and never listed. */
  { name: "start", base: "start", description: "Start here", menu: NONE },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));

/** The spec for a typed word, with or without its leading slash. `undefined` if unknown. */
export function resolveCommand(word: string): CommandSpec | undefined {
  return BY_NAME.get(word.trim().replace(/^\//, "").split("@")[0]!.toLowerCase());
}

/**
 * The argument the handler actually receives: the row's own word, then whatever the
 * user typed after the command. `/mcp_grant a3f9c2d1 data 0.5 2` becomes
 * `"grant a3f9c2d1 data 0.5 2"`, which is exactly what `/mcp grant …` already sent.
 */
export function commandArgument(spec: CommandSpec, typed: string): string {
  return [spec.argument, typed.trim()].filter((part) => part && part.length > 0).join(" ");
}

/** The four commands that resolve an identity. Every gateway routes these the same way. */
export function isIdentityCommand(base: CommandBase): boolean {
  return base === "link" || base === "mcp" || base === "unlink" || base === "whoami";
}

/**
 * Run one identity command. Kept here so a new channel cannot accidentally implement
 * its own — the argument must come from the command text and nothing else.
 */
export function runIdentityCommand(
  base: CommandBase,
  ctx: CommandContext,
  argument: string,
): Promise<string> {
  switch (base) {
    case "link":
      return linkCommand(ctx, argument);
    case "mcp":
      return mcpCommand(ctx, argument);
    case "unlink":
      return unlinkCommand(ctx, argument);
    case "whoami":
      return whoamiCommand(ctx);
    default:
      throw new Error(`${base} is not an identity command`);
  }
}

/** Telegram's `setMyCommands` payload, and the "/" menu behind the text box. */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> =
  COMMANDS.filter((c) => c.menu.includes("telegram")).map(({ name, description }) => ({
    command: name,
    description,
  }));

/**
 * What Discord registers — everything except `start`, which Discord has no button for.
 *
 * Deliberately wider than the Telegram menu: an unregistered Discord command does not
 * merely go unadvertised, it cannot be sent at all, and half of these are named in
 * replies Ward writes ("send /mcp_confirm ABC123"). Discord filters its picker as you
 * type, so the longer list costs nothing and the missing command would cost the flow.
 */
export const DISCORD_COMMANDS: readonly CommandSpec[] = COMMANDS.filter((c) => c.base !== "start");
