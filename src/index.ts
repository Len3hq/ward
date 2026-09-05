import { buildGraph } from "./agent/graph.ts";
import { loadConfig } from "./config.ts";
import { createDiscordGateway } from "./discord/gateway.ts";
import { installCdpProxy } from "./net.ts";
import { createGateway } from "./telegram/gateway.ts";

/**
 * Ward entrypoint. Builds the graph once and starts every gateway that has a token.
 *
 * The graph, and the Sibyl Memory behind it, are shared: which surface a turn
 * arrives on decides how it is rendered and how a confirmation is answered, never
 * what the user is allowed to do. See `MULTI-CHANNEL.md`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  installCdpProxy();
  const graph = buildGraph();

  const model = `${config.models.agent}${config.openaiApiKey ? "" : " — NO KEY, deterministic recall only"}`;
  const shutdown: Array<(signal: string) => void> = [];

  if (config.telegramBotToken) {
    const bot = createGateway(config.telegramBotToken, graph);
    const me = await bot.telegram.getMe();
    console.log(
      `Ward connected to Telegram as @${me.username} (${config.nodeEnv}, model ${model}).`,
    );
    void bot.launch();
    shutdown.push((signal) => bot.stop(signal));
  }

  if (config.discordBotToken) {
    const client = createDiscordGateway(config.discordBotToken, graph);
    await client.login(config.discordBotToken);
    shutdown.push(() => void client.destroy());
  }

  const stop = (signal: string) => {
    console.log(`\nReceived ${signal}, stopping Ward.`);
    for (const close of shutdown) close(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
