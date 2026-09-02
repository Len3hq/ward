import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { Context, Telegraf } from "telegraf";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";

/**
 * Telegram gateway. Adapted from Len3's `gateways/telegram.ts` — Telegraf
 * long-polling, streamed message edits, markdown→HTML, 4096-char split, and
 * approval-interrupt detection (`/newsession`, `/defaultsession`). User = Telegram
 * id; no linking / JWT.
 */

const EDIT_THROTTLE_MS = 900;
const TELEGRAM_LIMIT = 4096;

const YES =
  /^\s*(y|yes|yeah|yep|yup|confirm|confirmed|ok|okay|do it|go|send it|sure|approve[d]?)\s*!?\s*$/i;
const NO = /^\s*(n|no|nope|nah|cancel|stop|don'?t|abort|reject|deny)\s*!?\s*$/i;

interface ChatSession {
  seq: number;
  awaiting?: { thread: string; prompt: string };
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
  const threadId = (chatId: number, seq: number) => `tg:${chatId}:${seq}`;

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
        "Otherwise just talk to me: onboarding, your limits, or a trade.",
      ].join("\n"),
    ),
  );

  bot.command("newsession", (ctx) => {
    const s = session(ctx.chat.id);
    s.seq += 1;
    s.awaiting = undefined;
    return ctx.reply("Fresh session started. Your authorization in Sibyl Memory is unchanged.");
  });

  bot.command("defaultsession", (ctx) => {
    const s = session(ctx.chat.id);
    s.seq = 1;
    s.awaiting = undefined;
    return ctx.reply("Back to your default session.");
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const chatId = ctx.chat.id;
    const s = session(chatId);
    const thread = threadId(chatId, s.seq);
    const config = { configurable: { thread_id: thread } };

    // Resuming a pending confirmation?
    if (s.awaiting && s.awaiting.thread === thread) {
      const approved = YES.test(text) ? true : NO.test(text) ? false : null;
      if (approved === null) {
        await ctx.reply(`Please answer yes or no.\n\n${s.awaiting.prompt}`);
        return;
      }
      s.awaiting = undefined;
      await runGraph(ctx, chatId, graph, config, new Command({ resume: { approved } }), s, thread);
      return;
    }

    await runGraph(
      ctx,
      chatId,
      graph,
      config,
      { messages: [new HumanMessage(text)], tgId: String(ctx.from.id) },
      s,
      thread,
    );
  });

  return bot;
}

async function runGraph(
  ctx: Context,
  chatId: number,
  graph: WardGraph,
  config: { configurable: { thread_id: string } },
  input: Parameters<WardGraph["stream"]>[0],
  s: ChatSession,
  thread: string,
): Promise<void> {
  await ctx.sendChatAction("typing").catch(() => undefined);

  let placeholderId: number | undefined;
  let buffer = "";
  let lastEdit = 0;
  let interruptText: string | undefined;

  try {
    const stream = await graph.stream(input, { ...config, streamMode: ["messages", "values"] });
    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === "messages") {
        const piece = messageChunkText(chunk);
        if (piece) {
          buffer += piece;
          if (Date.now() - lastEdit > EDIT_THROTTLE_MS) {
            placeholderId = await editOrSend(ctx, chatId, placeholderId, buffer);
            lastEdit = Date.now();
          }
        }
      } else if (mode === "values") {
        const value = chunk as {
          __interrupt__?: Array<{ value?: { text?: string } }>;
          messages?: unknown[];
        };
        const pending = value.__interrupt__?.[0]?.value;
        if (pending) {
          interruptText = pending.text ?? "Confirm? (yes / no)";
        } else {
          const finalText = lastAiText(value.messages ?? []);
          if (finalText) buffer = finalText;
        }
      }
    }
  } catch (error) {
    console.error("graph run failed:", error);
    await ctx.reply("Something went wrong on my side. Try again in a moment.");
    return;
  }

  if (interruptText) {
    s.awaiting = { thread, prompt: interruptText };
    await sendFinal(ctx, chatId, placeholderId, interruptText);
    return;
  }
  await sendFinal(ctx, chatId, placeholderId, buffer || "(no response)");
}

// --- rendering ---

function messageChunkText(chunk: unknown): string {
  const first = Array.isArray(chunk) ? chunk[0] : chunk;
  const content = (first as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : "";
}

function lastAiText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message instanceof AIMessage &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      return message.content;
    }
  }
  return "";
}

/** During streaming: plain-text edits (partial markdown would break HTML parsing). */
async function editOrSend(
  ctx: Context,
  chatId: number,
  id: number | undefined,
  text: string,
): Promise<number> {
  const body = text.slice(0, TELEGRAM_LIMIT);
  if (id === undefined) {
    const sent = await ctx.reply(body);
    return sent.message_id;
  }
  await ctx.telegram.editMessageText(chatId, id, undefined, body).catch(() => undefined);
  return id;
}

/** Final message: HTML-formatted, split across the 4096 limit. */
async function sendFinal(
  ctx: Context,
  chatId: number,
  placeholderId: number | undefined,
  text: string,
): Promise<void> {
  const chunks = splitMessage(text, TELEGRAM_LIMIT);
  for (let i = 0; i < chunks.length; i++) {
    const html = mdToHtml(chunks[i]!);
    const extra = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
    if (i === 0 && placeholderId !== undefined) {
      await ctx.telegram
        .editMessageText(chatId, placeholderId, undefined, html, extra)
        .catch(() => ctx.reply(chunks[i]!));
    } else {
      await ctx.reply(html, extra).catch(() => ctx.reply(chunks[i]!));
    }
  }
}

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
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
