import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Message,
  type SendableChannels,
} from "discord.js";
import { randomUUID } from "node:crypto";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";
import type { ChannelAdapter } from "../gateway/adapter.ts";
import { runTurn } from "../gateway/core.ts";
import { linkCommand, unlinkCommand, whoamiCommand } from "../identity/commands.ts";
import { resolveUser } from "../identity/index.ts";
import { registerNotifier } from "../identity/notify.ts";

/**
 * Discord gateway. Same graph, same Sibyl Memory, same principal as Telegram — a
 * user who has linked the two accounts sees one set of limits, one daily cap and one
 * spend history from either app. The conversation is driven by `gateway/core.ts`;
 * only the Discord-shaped parts live here.
 *
 * Three ways this is genuinely not Telegram:
 *
 * - **2000 characters**, not 4096. `splitMessage` takes the limit from the adapter
 *   for exactly this reason.
 * - **Markdown is native**, so there is no render step — `mdToHtml` has no analogue
 *   and sending raw text is correct.
 * - **Confirmations are buttons.** Better than matching a typed "yes" against a
 *   regex, and it removes the ambiguity entirely. The clicking user is still checked
 *   against the account that was asked: a button is visible to anyone who can see
 *   the message, so the check is not redundant even in a DM.
 *
 * **DM-only.** A confirmation prompt naming someone's daily cap and spend history
 * does not belong in a shared channel, and neither does money movement. In a guild
 * Ward answers once, telling the user to DM it, and does nothing else. That also
 * keeps the bot off the privileged Message Content intent: Discord exempts DMs from
 * it, so this gateway asks only for `Guilds` + `DirectMessages`. (If message content
 * ever arrives empty, that exemption is what to check first — enabling Message
 * Content in the Developer Portal is the fix.)
 *
 * `Partials.Channel` is required or DM events never fire at all.
 *
 * See `MULTI-CHANNEL.md`.
 */

const DISCORD_LIMIT = 2000;
/** Streaming edits are cheap here, but not free — Discord rate-limits message edits. */
const EDIT_THROTTLE_MS = 1200;
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

interface ChatSession {
  seq: number;
}

const HELP = [
  "/newsession — start a fresh conversation (your authorization in Sibyl Memory is unchanged)",
  "/defaultsession — go back to your default conversation",
  "",
  "/link — get a code to reach this same Ward from another app",
  "/link <code> — redeem a code minted somewhere else",
  "/unlink <channel> — detach an app from your Ward",
  "/whoami — which accounts share your authorization",
  "",
  "Otherwise just talk to me: onboarding, your limits, or a trade.",
].join("\n");

export function createDiscordGateway(token: string, graph: WardGraph): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // without this, DMs never arrive
  });

  const sessions = new Map<string, ChatSession>();
  const session = (channelId: string): ChatSession => {
    let s = sessions.get(channelId);
    if (!s) {
      s = { seq: 1 };
      sessions.set(channelId, s);
    }
    return s;
  };

  registerNotifier("discord", async (accountId, text) => {
    const user = await client.users.fetch(accountId);
    await user.send(text);
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`Ward connected to Discord as ${ready.user.tag} (DM-only).`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // DM-only. Money movement and confirmation prompts do not belong in a guild.
    if (message.guild !== null) {
      if (message.mentions.has(client.user!)) {
        await message
          .reply(`DM me — I won't discuss your limits or move funds in a shared channel.`)
          .catch(() => undefined);
      }
      return;
    }

    const text = message.content.trim();
    if (!text) return;

    try {
      await handleDirectMessage(graph, session, message, text);
    } catch (error) {
      console.error("discord turn failed:", error);
      await message.channel.send("Something went wrong on my side.").catch(() => undefined);
    }
  });

  return client;
}

async function handleDirectMessage(
  graph: WardGraph,
  session: (channelId: string) => ChatSession,
  message: Message,
  text: string,
): Promise<void> {
  const accountId = message.author.id;
  const channel = message.channel as SendableChannels;
  const s = session(message.channelId);

  /**
   * Commands are handled here, before anything reaches the graph — a link code is
   * read from the command argument and nowhere else, so no model output or fetched
   * content can ever reach `redeemLinkCode`. Same property as the Telegram gateway's
   * Telegraf command registrations; keep it when adding a channel.
   */
  if (text.startsWith("/")) {
    const [word = "", ...rest] = text.slice(1).split(/\s+/);
    const argument = rest.join(" ");
    const ctx = { channel: "discord" as const, accountId };

    switch (word.toLowerCase()) {
      case "start":
        await channel.send(
          `${BRAND.name} — ${BRAND.tagline}.\n\nTell me your risk tolerance to get started, or send /help.`,
        );
        return;
      case "help":
        await channel.send(HELP);
        return;
      case "newsession":
        s.seq += 1;
        await channel.send(
          "Fresh session started. Your authorization in Sibyl Memory is unchanged.",
        );
        return;
      case "defaultsession":
        s.seq = 1;
        await channel.send("Back to your default session.");
        return;
      case "link":
        await channel.send(await linkCommand(ctx, argument));
        return;
      case "unlink":
        await channel.send(await unlinkCommand(ctx, argument));
        return;
      case "whoami":
        await channel.send(await whoamiCommand(ctx));
        return;
      default:
        await channel.send(`I don't know that command.\n\n${HELP}`);
        return;
    }
  }

  let userId: string;
  try {
    ({ userId } = await resolveUser("discord", accountId));
  } catch (error) {
    console.error("identity resolution failed:", error);
    await channel.send("I couldn't work out who you are just now. Try again in a moment.");
    return;
  }

  await runTurn({
    graph,
    adapter: discordAdapter(channel, accountId),
    threadId: `discord:${message.channelId}:${s.seq}`,
    userId,
    accountId,
    text,
  });
}

/**
 * The Discord half of the contract in `gateway/adapter.ts`.
 *
 * `accountId` is the user who is being talked to; `askConfirm` will accept a button
 * click from nobody else.
 */
export function discordAdapter(channel: SendableChannels, accountId: string): ChannelAdapter {
  const sent = new Map<string, Message>();

  return {
    channel: "discord",
    limit: DISCORD_LIMIT,
    editThrottleMs: EDIT_THROTTLE_MS,

    async typing() {
      await channel.sendTyping().catch(() => undefined);
    },

    // Discord renders markdown itself, so "plain" and "rendered" are the same text.
    async send(text) {
      const message = await channel.send(text.slice(0, DISCORD_LIMIT));
      sent.set(message.id, message);
      return message.id;
    },

    async edit(handle, text) {
      const message = sent.get(handle);
      if (!message) return;
      await message.edit(text.slice(0, DISCORD_LIMIT)).catch(() => undefined);
    },

    async askConfirm(text) {
      const nonce = randomUUID();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`ward:${nonce}:yes`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`ward:${nonce}:no`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary),
      );

      const prompt = await channel.send({
        content: text.slice(0, DISCORD_LIMIT),
        components: [row],
      });

      return new Promise<boolean | null>((resolve) => {
        const collector = prompt.createMessageComponentCollector({ time: CONFIRM_TIMEOUT_MS });

        collector.on("collect", async (interaction) => {
          if (!interaction.customId.startsWith(`ward:${nonce}:`)) return;

          // A button is visible to anyone who can see the message. Only the account
          // that was asked may answer for it.
          if (interaction.user.id !== accountId) {
            await interaction
              .reply({ content: "That isn't your confirmation.", flags: MessageFlags.Ephemeral })
              .catch(() => undefined);
            return;
          }

          const approved = interaction.customId.endsWith(":yes");
          // Clear the buttons so the decision cannot be replayed.
          await interaction.update({ components: [] }).catch(() => undefined);
          collector.stop("answered");
          resolve(approved);
        });

        collector.on("end", (_collected, reason) => {
          if (reason === "answered") return;
          // Timed out. Retract the buttons and report nothing happened — an
          // unanswered confirmation is a refusal, never an approval.
          void prompt.edit({ components: [] }).catch(() => undefined);
          resolve(null);
        });
      });
    },
  };
}
