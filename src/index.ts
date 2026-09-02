import { buildGraph } from "./agent/graph.ts";
import { loadConfig } from "./config.ts";
import { installCdpProxy } from "./net.ts";
import { createGateway } from "./telegram/gateway.ts";

/**
 * Ward entrypoint. Builds the graph and starts the Telegram bridge.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  installCdpProxy();
  const graph = buildGraph();
  const bot = createGateway(config.telegramBotToken, graph);

  const me = await bot.telegram.getMe();
  console.log(
    `Ward connected to Telegram as @${me.username} ` +
      `(${config.nodeEnv}, model ${config.models.agent}` +
      `${config.openaiApiKey ? "" : " — NO KEY, deterministic recall only"}).`,
  );

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
