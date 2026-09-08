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

/**
 * `/start`, and the first thing anyone ever reads. Says what Ward is, shows three
 * things to try, then asks the one question onboarding actually needs.
 */
export const WELCOME = [
  `${BRAND.name} — ${BRAND.tagline}.`,
  "",
  "I move money on Base for you — swaps, USDC sends, paid on-chain data — and I can",
  "hire other AI agents to assess a token. What I may do is written in your Sibyl",
  "Memory record. I check it before every action and I cannot exceed it.",
  "",
  "Try:",
  '  · "what am I allowed to do?"',
  '  · "what data can I buy?"',
  '  · "what\'s the risk score for PEPE"',
  "",
  `To get started, tell me your risk tolerance — ${RISK_WORDS}.`,
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
  "Account",
  "  /whoami — which accounts share your authorization",
  "  /link telegram · /link discord — reach this same Ward from another app",
  "  /link wallet — verify a wallet you control, as a way back in if you lose this account",
  "  /link — get a code to type in by hand · /link <code> — redeem one",
  "  /unlink <channel> — detach an app · /unlink wallet <address> — drop a wallet",
  "  /mcp — let Claude Code or Cursor use your Ward (they can read and ask, never spend,",
  "         until you grant it)",
  "  /newsession — a fresh conversation, your authorization unchanged",
  "  /defaultsession — go back to your default conversation",
].join("\n");

/**
 * Registered with Telegram so typing "/" autocompletes instead of matching nothing,
 * and so the Menu button beside the text box has something in it. Both were empty.
 *
 * `/start` is deliberately absent — Telegram renders its own Start button for it, and
 * listing it again just spends a row. Descriptions are written for someone who has
 * never heard of MCP or of us.
 */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "help", description: "Everything I can do" },
  { command: "whoami", description: "Which accounts share your authorization" },
  { command: "link", description: "Reach this same Ward from another app, or verify a wallet" },
  { command: "unlink", description: "Detach an app or a wallet" },
  { command: "mcp", description: "Let Claude Code or Cursor use your Ward" },
  { command: "newsession", description: "Start a fresh conversation" },
  { command: "defaultsession", description: "Back to your default conversation" },
];

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
