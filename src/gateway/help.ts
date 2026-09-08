import { BRAND } from "../config.ts";

/**
 * What Ward says about itself, written once for every channel.
 *
 * Telegram and Discord each carried their own identical copy of the help text, and
 * both listed the same thing: eleven commands, nine of them account plumbing, with
 * the actual product — swaps, sends, paid data, hiring an agent — in one sentence at
 * the bottom. A stranger opening the bot learned that it could be unlinked.
 *
 * So capabilities lead here and the plumbing follows, and every capability is written
 * as the sentence that starts it. Naming the phrase is the whole point: there is no
 * button for "swap $20 of USDC into ETH", and a user who does not know the words
 * cannot reach the feature.
 */

/** Onboarding takes one of these, so the welcome asks for one by name. */
const RISK_WORDS = "conservative, moderate or aggressive";

/** The chat apps a person can actually type `/start` into. */
type ChatChannel = "telegram" | "discord";

/** For "reach me anywhere": whichever chat app this one is not. */
const OTHER_APP: Record<ChatChannel, string> = {
  telegram: "Discord",
  discord: "Telegram",
};

/**
 * `/start`, and the first thing anyone ever reads.
 *
 * Written in markdown and rendered per channel — Telegram converts it to HTML on the
 * way out, Discord renders markdown natively. The previous version was sent as flat
 * text, which is why it read like a config dump: no emphasis, no structure, three
 * quoted phrases and a question. It described the mechanism and never made the case.
 *
 * What it says now is what is actually unusual here, in the order someone decides in:
 * what this thing does, why it is safe to leave running, that it gets better at
 * choosing counterparties, and where else it works. The safety paragraph is the
 * product — limits that live in memory rather than in code, checked before every
 * action, backed a second time on chain, and revocable by deleting the record — so it
 * gets its own heading rather than a clause in the opening sentence.
 *
 * Channel-aware because the copy is shared: offering Discord to someone already
 * standing in Discord is the kind of small wrongness that makes a bot feel unattended.
 */
export const welcome = (channel: ChatChannel): string =>
  [
    `**${BRAND.name}** — ${BRAND.tagline}.`,
    "",
    "I move real money on Base for you, inside limits you set once and can take back at",
    "any time.",
    "",
    "**What I can do**",
    '· **Swap and send** — "swap $20 of USDC into ETH" · "send $10 to 0x…"',
    "· **Buy on-chain data** — paid per call over x402. No subscription, no API key.",
    "· **Hire another AI agent** — a second opinion on a token, escrowed and settled on Base",
    "",
    "**Why you can leave me running**",
    "Your limits live in Sibyl Memory, not in my code. I read them before every single",
    "action and I cannot raise them. A revocable on-chain spend permission caps me again,",
    "independently. Delete the memory and I refuse to act at all — even where the chain",
    "would still let me.",
    "",
    "I also remember who delivered. Every agent I hire for you is scored on what it",
    "actually returned, so the next hire is a better one.",
    "",
    "**Reach me anywhere**",
    // Bare, never in backticks. Telegram turns a plain `/command` into something you
    // tap to run; wrapping it in `<code>` makes it copyable and dead instead, which
    // on the one screen meant to get someone moving is the wrong trade.
    `· /link_${OTHER_APP[channel].toLowerCase()} — the same Ward, in ${OTHER_APP[channel]}`,
    "· /link_mcp — the same Ward, inside Claude Code or Cursor",
    "One account, one set of limits, one spend history.",
    "",
    `**To begin**, tell me your risk tolerance — ${RISK_WORDS}.`,
  ].join("\n");

/**
 * `/help`. Two halves on purpose: what Ward can do, then the account chores. The
 * first half is phrased as speech because that is how it is used; the second is
 * phrased as commands because those must be typed exactly.
 */
export const HELP = [
  "What I can do — just say it in plain words:",
  "",
  "Check a token",
  '  · "what\'s the risk score for PEPE"',
  '  · "hire an agent to assess AERO" — I pick one from the Virtuals directory',
  "",
  "Move money",
  '  · "swap $20 of USDC into ETH"',
  '  · "send $10 to 0x…" — USDC to any Base address',
  "",
  "Buy on-chain data",
  '  · "what data can I buy?" — the full menu, and what each one costs',
  "",
  "Your wallet and your limits",
  '  · "generate my wallet" · "what am I allowed to do?" · "what\'s my balance?"',
  '  · "grant a $50 daily permission" — a revocable on-chain allowance',
  '  · "pause swaps" · "revoke my permission" · "what have I spent?"',
  "",
  "Every one of those is checked against your limits before anything moves, and",
  "shown to you to confirm first.",
  "",
  "Reach this same Ward from somewhere else",
  "  /link_discord · /link_telegram — one click, nothing to type",
  "  /link_mcp — connect Claude Code, Cursor or Zed",
  "  /link_wallet — verify a wallet, as a way back in if you lose this account",
  "  /link_code — get a code to type in by hand · /link <code> — redeem one",
  "",
  "Coding clients, and what they may spend",
  "  A connected client can read your limits and propose a spend — which comes back",
  "  here for you to approve. It cannot spend on its own unless you allow it.",
  "  /mcp — your clients, and what each one may spend",
  "  /mcp_grant — let one spend on its own, up to a limit you set",
  "  /mcp_stop — stop every client spending, right now",
  "",
  "Account",
  "  /whoami — which accounts and clients can reach your Ward",
  "  /unlink <app> — detach an app · /unlink_wallet <address> — drop a wallet",
  "  /unlink_mcp — disconnect every coding client",
  "  /forget_me — delete your limits and history from my memory. I stop acting until",
  "     you set new ones; your wallet and its balance are untouched.",
  "  /newsession — a fresh conversation, your authorization unchanged",
  "  /defaultsession — go back to your default conversation",
].join("\n");

/**
 * Shown inside an empty chat, before anyone presses Start — the one piece of copy
 * that has to earn the tap. Telegram caps it at 512 characters.
 */
export const BOT_DESCRIPTION = [
  `${BRAND.name} moves money on Base for you: swap and send USDC, buy premium on-chain`,
  "data, and hire other AI agents to assess a token before you touch it.",
  "",
  "What I am allowed to do is written down in memory — spend caps, paused actions, a",
  "revocable on-chain allowance — and I check it before every single action. I cannot",
  "exceed what you once told me, and you can take it back in one message.",
].join("\n");

/** Shown on the bot's profile page. Telegram caps this one at 120 characters. */
export const BOT_SHORT_DESCRIPTION = `${BRAND.name} — ${BRAND.tagline}.`;
