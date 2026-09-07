import { randomUUID } from "node:crypto";

import { Context, Telegraf, type Telegram } from "telegraf";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";
import type { ChannelAdapter, SendMode } from "../gateway/adapter.ts";
import { readAnswer } from "../gateway/answers.ts";
import { registerChannel } from "../gateway/channels.ts";
import { markCopyable } from "../gateway/format.ts";
import { runTurn, splitMessage } from "../gateway/core.ts";
import {
  announceLink,
  linkCommand,
  mcpCommand,
  unlinkCommand,
  whoamiCommand,
} from "../identity/commands.ts";
import { resolveUser } from "../identity/index.ts";
import { log, logError, preview } from "../log.ts";
import { redeemLinkState } from "../identity/linking.ts";

/**
 * Telegram gateway. Adapted from Len3's `gateways/telegram.ts` — Telegraf
 * long-polling, streamed message edits, markdown→HTML, 4096-char split, and
 * confirmation handling (`/newsession`, `/defaultsession`).
 *
 * Since Phase 11 the conversation itself is driven by `gateway/core.ts`. What is
 * left here is genuinely Telegram: HTML rendering, the 4096 limit, throttled edits,
 * answering a confirmation by typing "yes", and rendering addresses as `<code>` so
 * one tap copies them.
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
export const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long Telegraf lets one update's handler run — and the single most damaging
 * default in this file if it is left alone.
 *
 * A turn holding a confirmation is PARKED inside its handler until the user answers,
 * which is minutes, not seconds. Telegraf's default is 90 seconds, after which
 * `p-timeout` rejects the handler, Telegraf's default error handler rethrows, the
 * rejection surfaces out of `bot.launch()` — and `index.ts`, correctly reading that
 * as "polling died", exits the process. Every confirmation left open for 90 seconds
 * therefore killed Ward and took the in-memory session and graph checkpoint with it,
 * so the user's "yes" arrived at a process that had never asked them anything.
 * (Observed in production: `TimeoutError: Promise timed out after 90000 ms` on the
 * swap update, then an immediate restart.)
 *
 * Derived from the confirmation window on purpose, so the two cannot drift apart
 * again — but still finite, so a genuinely stuck handler is eventually collected.
 */
export const HANDLER_TIMEOUT_MS = CONFIRM_TIMEOUT_MS + 60_000;

interface ChatSession {
  seq: number;
  /**
   * Set while a confirmation is open. Answered by tapping a button (the normal
   * path) or by typing yes/no, whichever comes first.
   */
  pending?: {
    prompt: string;
    /** Nonce in the buttons' `callback_data`, so a stale tap cannot answer a new question. */
    nonce: string;
    /** The prompt message, so its buttons can be cleared once it is answered. */
    messageId?: number;
    resolve: (answer: boolean | null) => void;
  };
  /**
   * Turns for this chat, one after another.
   *
   * Nothing awaits this: the whole point is that the Telegram handler returns
   * immediately (see the note on `bot.on("text")`), while two messages from the same
   * chat still never run through the graph concurrently.
   */
  queue: Promise<void>;
}

export function createGateway(token: string, graph: WardGraph): Telegraf {
  const bot = new Telegraf(token, { handlerTimeout: HANDLER_TIMEOUT_MS });
  const sessions = new Map<number, ChatSession>();

  /**
   * One bad update must never stop the bot. Telegraf's default handler rethrows,
   * which ends long-polling and (by `index.ts`'s reading) the process — so a single
   * failed turn would take every other conversation down with it.
   */
  bot.catch(async (error, ctx) => {
    logError("telegram.update.failed", error, { account: String(ctx.from?.id ?? "?") });
    await ctx
      .reply("Something went wrong on my side. Try again in a moment.")
      .catch(() => undefined);
  });

  const session = (chatId: number): ChatSession => {
    let s = sessions.get(chatId);
    if (!s) {
      s = { seq: 1, queue: Promise.resolve() };
      sessions.set(chatId, s);
    }
    return s;
  };
  const threadId = (chatId: number, seq: number) => `telegram:${chatId}:${seq}`;

  /**
   * Make this gateway reachable without a `ctx`: another channel's link has to be
   * announced here (the phishing backstop), and an MCP proposal has to be delivered
   * here as a real turn.
   */
  registerChannel("telegram", {
    async notify(accountId, text) {
      await bot.telegram.sendMessage(accountId, text);
    },
    async adapterFor(accountId) {
      // In a DM the chat id and the user id are the same, so an account id is
      // enough to open a conversation with someone who isn't currently talking.
      const chatId = Number(accountId);
      if (!Number.isFinite(chatId)) return null;
      return telegramAdapter(bot.telegram, chatId, session(chatId));
    },
  });

  /**
   * `/start` — and, when it carries a payload, the Telegram half of one-click
   * linking (Phase 15.3).
   *
   * A `t.me/<bot>?start=<state>` link delivers the state as a start payload, so
   * Telegram does for free what Discord needs an OAuth2 round trip for: the user
   * clicks once and never transcribes anything. The payload is a link `state` with
   * every property a code has — single use, five minutes, rate limited — and, like
   * a code, it arrives as a command argument and never from model output.
   */
  bot.start(async (ctx) => {
    const payload = ctx.payload.trim();
    log("cmd", {
      channel: "telegram",
      account: String(ctx.from.id),
      command: "/start",
      args: payload.length > 0,
    });
    if (payload.length === 0) {
      await ctx.reply(
        `${BRAND.name} — ${BRAND.tagline}.\n\nTell me your risk tolerance to get started, or send /help.`,
      );
      return;
    }

    const accountId = String(ctx.from.id);
    const result = await redeemLinkState(payload, "telegram", accountId);
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    await ctx.reply(
      `${await announceLink(result, "telegram", accountId)}\n\n` +
        `You can talk to me right here. Try: "what am I allowed to do?"`,
    );
  });

  bot.help((ctx) =>
    ctx.reply(
      [
        "/newsession — start a fresh conversation (your authorization in Sibyl Memory is unchanged)",
        "/defaultsession — go back to your default conversation",
        "",
        "/link <channel> — one-click link to another app (telegram, discord)",
        "/link wallet — verify a wallet you control, as a way back in if you lose this account",
        "/link — get a code to type in by hand instead",
        "/link <code> — redeem a code minted somewhere else",
        "/unlink <channel> — detach an app from your Ward",
        "/unlink wallet <address> — drop a verified wallet",
        "/whoami — which accounts share your authorization",
        "/mcp — MCP tokens and what each is allowed to do",
        "",
        "Otherwise just talk to me: onboarding, your limits, a swap, or",
        '"send $10 to 0x…" to move USDC to any Base address.',
      ].join("\n"),
    ),
  );

  bot.command("newsession", (ctx) => {
    const s = session(ctx.chat.id);
    log("cmd", { channel: "telegram", account: String(ctx.from.id), command: "/newsession" });
    s.seq += 1;
    cancelPending(s);
    return ctx.reply("Fresh session started. Your authorization in Sibyl Memory is unchanged.");
  });

  bot.command("defaultsession", (ctx) => {
    const s = session(ctx.chat.id);
    log("cmd", { channel: "telegram", account: String(ctx.from.id), command: "/defaultsession" });
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
      // The argument can be a link code, so it is counted, never printed.
      log("cmd", {
        channel: "telegram",
        account: String(ctx.from?.id ?? ""),
        command: ctx.message.text.split(/\s+/)[0],
        args: argument.length > 0,
      });
      try {
        const reply = await handler(
          { channel: "telegram", accountId: String(ctx.from?.id ?? "") },
          argument,
        );
        await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
      } catch (error) {
        logError("cmd.failed", error, { channel: "telegram", account: String(ctx.from?.id ?? "") });
        await ctx.reply("That didn't work. Try again in a moment.");
      }
    };
  };

  bot.command("link", identity(linkCommand));
  bot.command("mcp", identity(mcpCommand));
  bot.command("unlink", identity(unlinkCommand));
  bot.command(
    "whoami",
    identity((ctx) => whoamiCommand(ctx)),
  );

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const s = session(chatId);

    // An unregistered command still reaches this handler, and its argument may be a
    // link code — counted, never printed, exactly as the registered commands do it.
    if (text.startsWith("/")) {
      const [word = "", ...rest] = text.split(/\s+/);
      log("cmd", {
        channel: "telegram",
        account: String(ctx.from.id),
        command: word,
        args: rest.length > 0,
        handled: false,
      });
      return;
    }

    // Every inbound message, before anything else can fail. A deployment serving
    // people has to look different in the log from one sitting idle.
    log("msg.in", {
      channel: "telegram",
      account: String(ctx.from.id),
      username: ctx.from.username,
      chat: chatId,
      session: s.seq,
      chars: text.length,
      pending_confirm: s.pending !== undefined,
      text: preview(text),
    });

    // A confirmation is open: this message is the answer, not a new turn. Typed
    // yes/no still works alongside the buttons — people type it.
    if (s.pending) {
      const answer = readAnswer(text);
      if (answer === null) {
        log("confirm.unclear", { channel: "telegram", account: String(ctx.from.id) });
        await ctx.reply(`Please answer yes or no, or use the buttons.\n\n${s.pending.prompt}`);
        return;
      }
      log("confirm.resolved", {
        channel: "telegram",
        account: String(ctx.from.id),
        answer: answer ? "yes" : "no",
        via: "text",
      });
      await settleConfirmation(ctx.telegram, chatId, s, answer);
      return;
    }

    const accountId = String(ctx.from.id);

    /**
     * The turn is NOT awaited here, and that is the whole fix for "Telegram hangs".
     *
     * Telegraf's polling loop is `for await (const updates of this) await
     * Promise.all(updates.map(handleUpdate))` — it does not fetch the next batch
     * until every handler in the current one has resolved. A turn parked on a
     * confirmation therefore froze the ENTIRE bot: the user's "Yes" was never
     * fetched from Telegram, the confirmation timed out after ten minutes, and only
     * then did the queued messages arrive — all at once, to a Ward that had stopped
     * waiting. The logs show it exactly: `confirm.answer answer=none ms=600160`,
     * then three `msg.in` lines in the same millisecond.
     *
     * So the handler returns immediately and the turn runs behind it, serialised per
     * chat so two messages still cannot interleave in the graph.
     */
    s.queue = s.queue.then(async () => {
      let userId: string;
      try {
        ({ userId } = await resolveUser("telegram", accountId));
      } catch (error) {
        logError("identity.failed", error, { channel: "telegram", account: accountId });
        await ctx.reply("I couldn't work out who you are just now. Try again in a moment.");
        return;
      }

      await runTurn({
        graph,
        adapter: telegramAdapter(ctx.telegram, chatId, s),
        threadId: threadId(chatId, s.seq),
        userId,
        accountId,
        text,
      });
    });
    // A failed turn must not poison the chat's queue for every later message.
    s.queue = s.queue.catch((error: unknown) => {
      logError("turn.failed", error, { channel: "telegram", account: accountId });
    });
  });

  /**
   * The button half of a confirmation (`callback_query`).
   *
   * A tap is just another update, so this only works because the text handler above
   * no longer blocks the polling loop — buttons alone would have queued behind the
   * parked turn exactly as the typed "Yes" did.
   */
  bot.on("callback_query", async (ctx) => {
    const data =
      "data" in ctx.callbackQuery && typeof ctx.callbackQuery.data === "string"
        ? ctx.callbackQuery.data
        : "";
    const chat = ctx.callbackQuery.message?.chat;
    if (!chat) return;
    const s = session(chat.id);

    const match = /^ward:([^:]+):(yes|no)$/.exec(data);
    // A tap on a question that has already been answered, or on one from a previous
    // process. Say so rather than leaving the client spinning.
    if (!match || !s.pending || s.pending.nonce !== match[1]) {
      await ctx.answerCbQuery("That confirmation is no longer open.").catch(() => undefined);
      return;
    }
    // In a DM the chat id IS the user id; anyone else tapping is not who was asked.
    if (String(ctx.from.id) !== String(chat.id)) {
      await ctx.answerCbQuery("That isn't your confirmation.").catch(() => undefined);
      return;
    }

    const approved = match[2] === "yes";
    log("confirm.resolved", {
      channel: "telegram",
      account: String(ctx.from.id),
      answer: approved ? "yes" : "no",
      via: "button",
    });
    await ctx.answerCbQuery(approved ? "Approved" : "Cancelled").catch(() => undefined);
    await settleConfirmation(ctx.telegram, chat.id, s, approved);
  });

  return bot;
}

function cancelPending(s: ChatSession): void {
  s.pending?.resolve(null);
  s.pending = undefined;
}

/**
 * Hand the answer to the waiting turn, and retract the buttons so the decision
 * cannot be replayed — the same property Discord gets from clearing its components.
 */
async function settleConfirmation(
  telegram: Telegram,
  chatId: number,
  s: ChatSession,
  answer: boolean,
): Promise<void> {
  const pending = s.pending;
  if (!pending) return;
  s.pending = undefined;

  if (pending.messageId !== undefined) {
    await telegram
      .editMessageReplyMarkup(chatId, pending.messageId, undefined, {
        inline_keyboard: [],
      })
      .catch(() => undefined);
  }
  pending.resolve(answer);
}

/**
 * The Telegram half of the contract in `gateway/adapter.ts`.
 *
 * Built from `Telegram` + a chat id rather than a Telegraf `Context`, so it works
 * both for the user who just messaged us and for one we are pushing a proposal to.
 */
function telegramAdapter(telegram: Telegram, chatId: number, s: ChatSession): ChannelAdapter {
  const body = (text: string, mode: SendMode) =>
    mode === "rendered" ? render(text) : text.slice(0, TELEGRAM_LIMIT);

  const extra = (mode: SendMode) =>
    mode === "rendered"
      ? { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } }
      : {};

  return {
    channel: "telegram",
    limit: TELEGRAM_LIMIT,
    editThrottleMs: EDIT_THROTTLE_MS,

    async typing() {
      await telegram.sendChatAction(chatId, "typing").catch(() => undefined);
    },

    async send(text, mode) {
      // A rendering slip must not lose the message — fall back to plain text.
      const sent = await telegram
        .sendMessage(chatId, body(text, mode), extra(mode))
        .catch(() => telegram.sendMessage(chatId, text.slice(0, TELEGRAM_LIMIT)));
      return String(sent.message_id);
    },

    async edit(handle, text, mode) {
      await telegram
        .editMessageText(chatId, Number(handle), undefined, body(text, mode), extra(mode))
        .catch(() => undefined);
    },

    /**
     * Two buttons, and a typed yes/no as a fallback.
     *
     * The buttons are what people reach for — Discord had them and Telegram did not,
     * which is half of why answering on Telegram felt broken. The other half was the
     * polling loop, fixed in the text handler above; without that fix a tap would
     * have queued behind the very turn it was meant to answer.
     */
    async askConfirm(text) {
      const nonce = randomUUID().slice(0, 8);
      const sent = await telegram
        .sendMessage(chatId, render(text), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `ward:${nonce}:yes` },
                { text: "✖️ Cancel", callback_data: `ward:${nonce}:no` },
              ],
            ],
          },
        })
        // A markup failure must not lose the question — the typed answer still works.
        .catch(() => telegram.sendMessage(chatId, text.slice(0, TELEGRAM_LIMIT)));

      return new Promise<boolean | null>((resolve) => {
        const settle = (answer: boolean | null): void => {
          clearTimeout(timer);
          resolve(answer);
        };
        const timer = setTimeout(() => {
          // Only clear the slot if it is still ours — a newer question may own it.
          if (s.pending?.resolve === settle) {
            s.pending = undefined;
            void telegram
              .editMessageReplyMarkup(chatId, sent.message_id, undefined, { inline_keyboard: [] })
              .catch(() => undefined);
          }
          resolve(null);
        }, CONFIRM_TIMEOUT_MS);
        s.pending = { prompt: text, nonce, messageId: sent.message_id, resolve: settle };
      });
    },
  };
}

// --- Telegram rendering ---

export { splitMessage };

/**
 * A finished message, ready for Telegram: addresses made copyable first, then
 * markdown to HTML. Order matters — `markCopyable` adds backticks, and `mdToHtml`
 * is what turns them into the `<code>` spans Telegram copies on tap.
 */
export function render(md: string): string {
  return mdToHtml(markCopyable(md, "inline")).slice(0, TELEGRAM_LIMIT);
}

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
