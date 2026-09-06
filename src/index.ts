import { resetBackend } from "../memory/index.ts";
import { buildGraph } from "./agent/graph.ts";
import { loadConfig } from "./config.ts";
import { createDiscordGateway } from "./discord/gateway.ts";
import { startProposalWatcher } from "./gateway/proposals.ts";
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
  let stopping = false;

  if (config.telegramBotToken) {
    const bot = createGateway(config.telegramBotToken, graph);
    const me = await bot.telegram.getMe();
    console.log(
      `Ward connected to Telegram as @${me.username} (${config.nodeEnv}, model ${model}).`,
    );
    // `bot.launch()` never resolves while polling, so its rejection is the only
    // signal that polling died — and unhandled it takes the process down.
    //
    // On SIGTERM that happens EVERY time: aborting the in-flight `getUpdates`
    // makes Telegraf run `redactToken`, which assigns to `error.message` — a
    // readonly property under Bun. The resulting "Attempted to assign to readonly
    // property" killed the old container on every redeploy, which Railway reports
    // as a crashed deployment. During shutdown it is expected noise; at any other
    // time polling has genuinely stopped (a 409 means a second poller took the
    // token, usually a local `bun run dev`) and restarting is the right move.
    void bot.launch().catch((error: unknown) => {
      if (stopping) return;
      console.error("Telegram long-polling stopped:", error);
      process.exit(1);
    });
    shutdown.push((signal) => bot.stop(signal));
  }

  if (config.discordBotToken) {
    const client = createDiscordGateway(config.discordBotToken, graph);
    await client.login(config.discordBotToken);
    shutdown.push(() => void client.destroy());
  }

  // Proposals made over MCP are queued in Sibyl Memory by that separate process;
  // this is what picks them up and replays them as a real turn on a human channel.
  const proposals = startProposalWatcher(graph);
  shutdown.push(() => proposals.stop());

  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\nReceived ${signal}, stopping Ward.`);
    for (const close of shutdown) close(signal);
    // Handling SIGTERM overrides the default "exit now", so Ward has to exit
    // itself. The Sibyl Memory backend holds a spawned `sibyl-memory-mcp` child
    // over stdio whose pipes are live handles, so without closing it the loop
    // never drains and the container waits to be SIGKILLed.
    const forced = setTimeout(() => process.exit(0), 5_000);
    if (typeof forced.unref === "function") forced.unref();
    void resetBackend().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
