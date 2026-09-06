import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputApplicationCommandData,
  type Message,
  type SendableChannels,
} from "discord.js";
import { randomUUID } from "node:crypto";

import type { WardGraph } from "../agent/graph.ts";
import { BRAND } from "../config.ts";
import type { ChannelAdapter } from "../gateway/adapter.ts";
import { registerChannel, registerDmLink } from "../gateway/channels.ts";
import { runTurn } from "../gateway/core.ts";
import { linkCommand, mcpCommand, unlinkCommand, whoamiCommand } from "../identity/commands.ts";
import { resolveExisting, resolveUser } from "../identity/index.ts";

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

/**
 * An unknown Discord account gets this instead of onboarding.
 *
 * `resolveUser` MINTS a principal on first contact, so simply talking here used to
 * create a second Ward — and then `/link` refused the code, because moving a
 * principal that already holds an authorization record is a silent ledger merge.
 * The trap was invisible: the punishment arrived one step after the mistake.
 *
 * So an account we have never seen has to say which it is first. Nothing is minted
 * until it does.
 */
export const OPT_IN = /\b(set me up|sign me up|onboard me|start fresh|new ward)\b/i;

function firstContact(): string {
  return [
    `${BRAND.name} — ${BRAND.tagline}.`,
    "",
    "I don't know this Discord account yet. Two ways forward:",
    "",
    "**Already use Ward elsewhere?** Send `/link` there to get a code, then send " +
      "`/link WARD-XXXX-XXXX` here. Your limits, spend history and wallet all come with you — " +
      "one daily cap across both apps.",
    "",
    '**Starting fresh?** Say **"set me up"** and I\'ll onboard this account as a new Ward.',
  ].join("\n");
}

interface ChatSession {
  seq: number;
}

const HELP = [
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

  registerChannel("discord", {
    async notify(accountId, text) {
      const user = await client.users.fetch(accountId);
      await user.send(text);
    },
    async adapterFor(accountId) {
      // Open (or reuse) the DM channel, so a proposal can be delivered to someone
      // who is not currently talking to us.
      const user = await client.users.fetch(accountId);
      const dm = await user.createDM();
      return discordAdapter(dm, accountId);
    },
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`Ward connected to Discord as ${ready.user.tag} (DM-only).`);
    // The door to hand someone minting a code on Telegram.
    registerDmLink("discord", `https://discord.com/users/${ready.user.id}`);
    // Best effort, and deliberately so: registered commands are a convenience —
    // Discord's client fights you when you type "/link" and it matches nothing.
    // The text path below stays the guaranteed one, so a registration failure
    // (missing `applications.commands` scope, a propagation delay) must not take
    // the gateway down with it.
    void ready.application.commands.set(SLASH_COMMANDS).catch((error: unknown) => {
      console.error("discord slash-command registration failed (text commands still work):", error);
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== null) {
      await interaction
        .reply({
          content: "DM me — I won't discuss your limits or move funds in a shared channel.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
      return;
    }
    try {
      await interaction.deferReply();
      const reply = await runCommand(
        session(interaction.channelId),
        { channel: "discord", accountId: interaction.user.id },
        interaction.commandName,
        interaction.options.getString("code") ??
          interaction.options.getString("channel") ??
          interaction.options.getString("args") ??
          "",
      );
      await interaction.editReply(reply.slice(0, DISCORD_LIMIT));
    } catch (error) {
      console.error("discord command failed:", error);
      await interaction.editReply("Something went wrong on my side.").catch(() => undefined);
    }
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

/**
 * One command implementation, two front doors: a typed `/link …` message and a
 * registered slash command. Both return text rather than sending it, so the caller
 * decides between `channel.send` and `interaction.editReply`.
 *
 * Commands are handled here, before anything reaches the graph — a link code is
 * read from the command argument and nowhere else, so no model output or fetched
 * content can ever reach `redeemLinkCode`. Same property as the Telegram gateway's
 * Telegraf command registrations; keep it when adding a channel.
 */
async function runCommand(
  s: ChatSession,
  ctx: { channel: "discord"; accountId: string },
  word: string,
  argument: string,
): Promise<string> {
  switch (word.toLowerCase()) {
    case "start":
      return `${BRAND.name} — ${BRAND.tagline}.\n\nTell me your risk tolerance to get started, or send /help.`;
    case "help":
      return HELP;
    case "newsession":
      s.seq += 1;
      return "Fresh session started. Your authorization in Sibyl Memory is unchanged.";
    case "defaultsession":
      s.seq = 1;
      return "Back to your default session.";
    case "link":
      return linkCommand(ctx, argument);
    case "unlink":
      return unlinkCommand(ctx, argument);
    case "whoami":
      return whoamiCommand(ctx);
    case "mcp":
      return mcpCommand(ctx, argument);
    default:
      return `I don't know that command.\n\n${HELP}`;
  }
}

/** Registered so Discord's client autocompletes them instead of matching nothing. */
export const SLASH_COMMANDS: ChatInputApplicationCommandData[] = [
  {
    type: ApplicationCommandType.ChatInput,
    name: "link",
    description: "Reach this same Ward from another app — or redeem a code from one",
    options: [
      {
        name: "code",
        description:
          "A channel to link (telegram), a code minted elsewhere, or 'mcp'. Omit to mint a code.",
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "unlink",
    description: "Detach an app from your Ward",
    options: [
      {
        name: "channel",
        description: "telegram, discord or mcp",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "whoami",
    description: "Which accounts share your authorization",
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "newsession",
    description: "Start a fresh conversation (your limits are unchanged)",
  },
  {
    type: ApplicationCommandType.ChatInput,
    name: "defaultsession",
    description: "Go back to your default conversation",
  },
  { type: ApplicationCommandType.ChatInput, name: "help", description: "What Ward can do" },
];

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
    await channel.send(
      await runCommand(s, { channel: "discord", accountId }, word, rest.join(" ")),
    );
    return;
  }

  // Never mint a principal for an account that has not said which it is. See OPT_IN.
  if ((await resolveExisting("discord", accountId)) === null && !OPT_IN.test(text)) {
    await channel.send(firstContact());
    return;
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
