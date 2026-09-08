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
import { HELP, welcome } from "../gateway/help.ts";
import {
  DISCORD_COMMANDS,
  commandArgument,
  isIdentityCommand,
  resolveCommand,
  runIdentityCommand,
} from "../gateway/commands.ts";
import type { ChannelAdapter, SendMode } from "../gateway/adapter.ts";
import { registerChannel, registerDmLink } from "../gateway/channels.ts";
import { markCopyable } from "../gateway/format.ts";
import { runTurn } from "../gateway/core.ts";

import { resolveExisting, resolveUser } from "../identity/index.ts";
import { log, logError, preview } from "../log.ts";

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
 * - **Markdown is native**, so there is no `mdToHtml` analogue; the only rendering
 *   is putting addresses in a fenced code block, which is Discord's copy affordance.
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
      log("cmd", {
        channel: "discord",
        account: interaction.user.id,
        command: `/${interaction.commandName}`,
      });
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
      logError("cmd.failed", error, { channel: "discord", account: interaction.user.id });
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
      logError("discord.turn.failed", error, {
        channel: "discord",
        account: message.author.id,
      });
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
  const spec = resolveCommand(word);
  if (spec === undefined) return `I don't know that command.\n\n${HELP}`;

  // The one-word aliases route here too: `/link_mcp` resolves to the `link` handler
  // with "mcp" already in front of whatever the user typed.
  if (isIdentityCommand(spec.base)) {
    return runIdentityCommand(spec.base, ctx, commandArgument(spec, argument));
  }

  switch (spec.base) {
    case "start":
      return welcome("discord");
    case "help":
      return HELP;
    case "newsession":
      s.seq += 1;
      return "Fresh session started. Your authorization in Sibyl Memory is unchanged.";
    case "defaultsession":
      s.seq = 1;
      return "Back to your default session.";
    default:
      return `I don't know that command.\n\n${HELP}`;
  }
}

/**
 * Registered so Discord's client autocompletes them instead of matching nothing.
 *
 * Derived from the shared table rather than written out again: a command that is
 * advertised here but unrouted in `runCommand` is the exact failure this project has
 * already shipped once, and one list cannot disagree with itself.
 *
 * Every row takes a free-text argument. Discord would let each one declare typed
 * options, but the handlers parse a string — the same string a typed `/link_mcp …`
 * message produces — and giving one door a different shape than the other is how the
 * two drift apart.
 */
export const SLASH_COMMANDS: ChatInputApplicationCommandData[] = DISCORD_COMMANDS.map((spec) => ({
  type: ApplicationCommandType.ChatInput,
  name: spec.name,
  description: spec.description,
  ...(spec.hint === undefined
    ? {}
    : {
        options: [
          {
            name: "args",
            description: spec.hint,
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      }),
}));

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
    // The argument may be a link code: counted, never printed.
    log("cmd", {
      channel: "discord",
      account: accountId,
      command: `/${word}`,
      args: rest.length > 0,
    });
    await channel.send(
      await runCommand(s, { channel: "discord", accountId }, word, rest.join(" ")),
    );
    return;
  }

  log("msg.in", {
    channel: "discord",
    account: accountId,
    username: message.author.username,
    chat: message.channelId,
    session: s.seq,
    chars: text.length,
    text: preview(text),
  });

  // Never mint a principal for an account that has not said which it is. See OPT_IN.
  if ((await resolveExisting("discord", accountId)) === null && !OPT_IN.test(text)) {
    await channel.send(firstContact());
    return;
  }

  let userId: string;
  try {
    ({ userId } = await resolveUser("discord", accountId));
  } catch (error) {
    logError("identity.failed", error, { channel: "discord", account: accountId });
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
/**
 * Discord has no tap-to-copy for inline code, but a fenced code block carries a copy
 * button on desktop and long-presses cleanly on mobile — so an address goes in one.
 * See `gateway/format.ts`.
 */
function render(text: string, mode: SendMode): string {
  const body = mode === "rendered" ? markCopyable(text, "block") : text;
  return body.slice(0, DISCORD_LIMIT);
}

export function discordAdapter(channel: SendableChannels, accountId: string): ChannelAdapter {
  const sent = new Map<string, Message>();

  return {
    channel: "discord",
    limit: DISCORD_LIMIT,
    editThrottleMs: EDIT_THROTTLE_MS,

    async typing() {
      await channel.sendTyping().catch(() => undefined);
    },

    // Discord renders markdown itself, so a finished message needs no render step —
    // only the address pass, which mid-stream fragments must not get (half an
    // address must never be presented as the whole of one).
    async send(text, mode) {
      const message = await channel.send(render(text, mode));
      sent.set(message.id, message);
      return message.id;
    },

    async edit(handle, text, mode) {
      const message = sent.get(handle);
      if (!message) return;
      await message.edit(render(text, mode)).catch(() => undefined);
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
        content: render(text, "rendered"),
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
