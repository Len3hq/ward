import { Telegraf } from "telegraf";
import { loadConfig } from "./config.ts";

/**
 * Ward — dev entrypoint (Phase 0).
 *
 * Connects to Telegram over long-polling and echoes any text message back. The
 * graph, memory layer, and execution engine are wired in over Phases 1–6; this
 * file only proves the process starts and the chat surface is live.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const bot = new Telegraf(config.telegramBotToken);

  bot.on("text", async (ctx) => {
    await ctx.reply(`Ward (Phase 0) is alive. You said: ${ctx.message.text}`);
  });

  const me = await bot.telegram.getMe();
  console.log(`Ward connected to Telegram as @${me.username} (${config.nodeEnv}, long-polling).`);

  // bot.launch() resolves only once the bot stops; run it in the background.
  void bot.launch();

  const stop = (signal: string) => {
    console.log(`\nReceived ${signal}, stopping Ward.`);
    bot.stop(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
