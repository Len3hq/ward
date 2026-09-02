import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { Telegraf } from "telegraf";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";

/**
 * Minimal Telegram bridge: message → graph → reply. `/newsession` rotates the
 * `thread_id`, which resets the `MemorySaver` conversation while Sibyl Memory
 * persists — the fresh-session recall demo.
 *
 * Phase 3 vendors Len3's full `gateways/telegram.ts` on top of this (streaming
 * edits, markdown→HTML, 4096-char split, approval-interrupt detection).
 */

interface Session {
  seq: number;
}

export function createGateway(token: string, graph: WardGraph): Telegraf {
  const bot = new Telegraf(token);
  const sessions = new Map<number, Session>();

  const threadId = (chatId: number): string => {
    const session = sessions.get(chatId) ?? { seq: 1 };
    sessions.set(chatId, session);
    return `tg:${chatId}:${session.seq}`;
  };

  bot.start((ctx) =>
    ctx.reply(
      `${BRAND.name} — ${BRAND.tagline}.\n\nTell me your risk tolerance to get started, or send /help.`,
    ),
  );

  bot.help((ctx) =>
    ctx.reply(
      [
        "/newsession — start a fresh conversation (I still recall your authorization)",
        "/help — this message",
        "",
        "Otherwise just talk to me: onboarding, your limits, or a trade.",
      ].join("\n"),
    ),
  );

  bot.command("newsession", (ctx) => {
    const session = sessions.get(ctx.chat.id) ?? { seq: 1 };
    session.seq += 1;
    sessions.set(ctx.chat.id, session);
    return ctx.reply("Fresh session started. Your authorization in Sibyl Memory is unchanged.");
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    await ctx.sendChatAction("typing");
    try {
      const result = await graph.invoke(
        { messages: [new HumanMessage(text)], tgId: String(ctx.from.id) },
        { configurable: { thread_id: threadId(ctx.chat.id) } },
      );
      await ctx.reply(lastReply(result.messages));
    } catch (error) {
      console.error("graph invoke failed:", error);
      await ctx.reply("Something went wrong on my side. Try again in a moment.");
    }
  });

  return bot;
}

function lastReply(messages: unknown[]): string {
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
  return "(no response)";
}
