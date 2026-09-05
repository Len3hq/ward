import { Context, Telegraf } from "telegraf";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";
import type { ChannelAdapter, SendMode } from "../gateway/adapter.ts";
import { runTurn, splitMessage } from "../gateway/core.ts";
import { linkCommand, unlinkCommand, whoamiCommand } from "../identity/commands.ts";
import { resolveUser } from "../identity/index.ts";
import { registerNotifier } from "../identity/notify.ts";

/**
 * Telegram gateway. Adapted from Len3's `gateways/telegram.ts` — Telegraf
 * long-polling, streamed message edits, markdown→HTML, 4096-char split, and
 * confirmation handling (`/newsession`, `/defaultsession`).
 *
 * Since Phase 11 the conversation itself is driven by `gateway/core.ts`. What is
 * left here is genuinely Telegram: HTML rendering, the 4096 limit, throttled edits,
 * and answering a confirmation by typing "yes".
 *
 * A Telegram id is not an identity, it is an *account*: `resolveUser` maps it to the
 * principal that keys everything in Sibyl Memory, minting one on first contact. The
 * account itself is the proof — a Telegram DM is already authenticated — which is
 * why `first_contact` is sound here and not on MCP. Threads stay per-channel
 * (`telegram:<chat>:<seq>`) while the memory behind them is shared.
 *
 * `/link`, `/unlink` and `/whoami` are registered as Telegraf commands, so they run
 * **outside the graph entirely** — a link code is only ever read from a slash-command
 * argument, never from anything the model has seen. Keep it that way.
 *
 * See `MULTI-CHANNEL.md`.
 */

const EDIT_THROTTLE_MS = 900;
const TELEGRAM_LIMIT = 4096;
/** How long a typed confirmation stays open before the turn gives up on it. */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

const YES =
  /^\s*(y|yes|yeah|yep|yup|confirm|confirmed|ok|okay|do it|go|send it|sure|approve[d]?)\s*!?\s*$/i;
const NO = /^\s*(n|no|nope|nah|cancel|stop|don'?t|abort|reject|deny)\s*!?\s*$/i;

interface ChatSession {
  seq: number;
  /** Set while a confirmation is open; the next yes/no resolves it. */
  pending?: { prompt: string; resolve: (answer: boolean | null) => void };
}

export function createGateway(token: string, graph: WardGraph): Telegraf {
  const bot = new Telegraf(token);
  const sessions = new Map<number, ChatSession>();

  const session = (chatId: number): ChatSession => {
    let s = sessions.get(chatId);
    if (!s) {
      s = { seq: 1 };
      sessions.set(chatId, s);
    }
    return s;
  };
  const threadId = (chatId: number, seq: number) => `telegram:${chatId}:${seq}`;

  // So another channel's link can be announced here — the phishing backstop.
  registerNotifier("telegram", async (accountId, text) => {
    await bot.telegram.sendMessage(accountId, text);
  });

  bot.start((ctx) =>
    ctx.reply(
      `${BRAND.name} — ${BRAND.tagline}.\n\nTell me your risk tolerance to get started, or send /help.`,
    ),
  );

  bot.help((ctx) =>
    ctx.reply(
      [
        "/newsession — start a fresh conversation (your authorization in Sibyl Memory is unchanged)",
        "/defaultsession — go back to your default conversation",
        "",
        "/link — get a code to reach this same Ward from another app",
        "/link <code> — redeem a code minted somewhere else",
        "/unlink <channel> — detach an app from your Ward",
        "/whoami — which accounts share your authorization",
        "",
        "Otherwise just talk to me: onboarding, your limits, or a trade.",
      ].join("\n"),
    ),
  );

  bot.command("newsession", (ctx) => {
    const s = session(ctx.chat.id);
    s.seq += 1;
    cancelPending(s);
    return ctx.reply("Fresh session started. Your authorization in Sibyl Memory is unchanged.");
  });

  bot.command("defaultsession", (ctx) => {
    const s = session(ctx.chat.id);
    s.seq = 1;
    cancelPending(s);
    return ctx.reply("Back to your default session.");
  });

  /**
   * Identity commands. These never enter the graph: the argument is taken straight
   * off the command text, so no model output or fetched content can ever reach
   * `redeemLinkCode`.
   */
  const identity = (
    handler: (ctx: { channel: "telegram"; accountId: string }, argument: string) => Promise<string>,
  ) => {
    return async (ctx: Context & { message: { text: string } }) => {
      const argument = ctx.message.text.replace(/^\/\S+\s*/, "");
      try {
        const reply = await handler(
          { channel: "telegram", accountId: String(ctx.from?.id ?? "") },
          argument,
        );
        await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
      } catch (error) {
        console.error("identity command failed:", error);
        await ctx.reply("That didn't work. Try again in a moment.");
      }
    };
  };

  bot.command("link", identity(linkCommand));
  bot.command("unlink", identity(unlinkCommand));
  bot.command(
    "whoami",
    identity((ctx) => whoamiCommand(ctx)),
  );

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const s = session(chatId);

    // A confirmation is open: this message is the answer, not a new turn.
    if (s.pending) {
      const answer = YES.test(text) ? true : NO.test(text) ? false : null;
      if (answer === null) {
        await ctx.reply(`Please answer yes or no.\n\n${s.pending.prompt}`);
        return;
      }
      const { resolve } = s.pending;
      s.pending = undefined;
      resolve(answer);
      return;
    }

    const accountId = String(ctx.from.id);
    let userId: string;
    try {
      ({ userId } = await resolveUser("telegram", accountId));
    } catch (error) {
      console.error("identity resolution failed:", error);
      await ctx.reply("I couldn't work out who you are just now. Try again in a moment.");
      return;
    }

    await runTurn({
      graph,
      adapter: telegramAdapter(ctx, chatId, s),
      threadId: threadId(chatId, s.seq),
      userId,
      accountId,
      text,
    });
  });

  return bot;
}

function cancelPending(s: ChatSession): void {
  s.pending?.resolve(null);
  s.pending = undefined;
}

/** The Telegram half of the contract in `gateway/adapter.ts`. */
function telegramAdapter(ctx: Context, chatId: number, s: ChatSession): ChannelAdapter {
  const body = (text: string, mode: SendMode) =>
    mode === "rendered" ? mdToHtml(text) : text.slice(0, TELEGRAM_LIMIT);

  const extra = (mode: SendMode) =>
    mode === "rendered"
      ? { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } }
      : {};

  return {
    channel: "telegram",
    limit: TELEGRAM_LIMIT,
    editThrottleMs: EDIT_THROTTLE_MS,

    async typing() {
      await ctx.sendChatAction("typing").catch(() => undefined);
    },

    async send(text, mode) {
      // A rendering slip must not lose the message — fall back to plain text.
      const sent = await ctx
        .reply(body(text, mode), extra(mode))
        .catch(() => ctx.reply(text.slice(0, TELEGRAM_LIMIT)));
      return String(sent.message_id);
    },

    async edit(handle, text, mode) {
      await ctx.telegram
        .editMessageText(chatId, Number(handle), undefined, body(text, mode), extra(mode))
        .catch(() => undefined);
    },

    /**
     * Telegram has no button here: the answer is the next message the user types,
     * matched against the yes/no patterns by the text handler above. That handler
     * holds the resolver, so this turn simply awaits it.
     */
    async askConfirm(text) {
      await ctx.reply(mdToHtml(text), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });

      return new Promise<boolean | null>((resolve) => {
        const settle = (answer: boolean | null): void => {
          clearTimeout(timer);
          resolve(answer);
        };
        const timer = setTimeout(() => {
          // Only clear the slot if it is still ours — a newer question may own it.
          if (s.pending?.resolve === settle) s.pending = undefined;
          resolve(null);
        }, CONFIRM_TIMEOUT_MS);
        s.pending = { prompt: text, resolve: settle };
      });
    },
  };
}

// --- Telegram rendering ---

export { splitMessage };

/** Minimal markdown → Telegram HTML. */
export function mdToHtml(md: string): string {
  let s = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_m, _lang, code: string) => `<pre>${code.replace(/\n$/, "")}</pre>`,
  );
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return s;
}
