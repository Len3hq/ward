import { afterEach, describe, expect, test } from "bun:test";
import {
  ApplicationCommandType,
  GatewayIntentBits,
  Partials,
  type Client,
  type SendableChannels,
} from "discord.js";

import {
  OPT_IN,
  SLASH_COMMANDS,
  createDiscordGateway,
  discordAdapter,
} from "../src/discord/gateway.ts";
import { buildGraph } from "../src/agent/graph.ts";

/**
 * Discord-specific wiring. The conversation itself is covered by
 * `gateway.channel.test.ts` through the shared `runTurn`; what is left to check here
 * are the pieces that fail *silently* when they are wrong.
 */

let client: Client | undefined;

afterEach(async () => {
  await client?.destroy();
  client = undefined;
});

describe("client configuration", () => {
  test("declares Partials.Channel — without it DM events never fire at all", () => {
    client = createDiscordGateway("not-a-real-token", buildGraph());
    expect(client.options.partials).toContain(Partials.Channel);
  });

  test("asks for DirectMessages, and not the privileged MessageContent intent", () => {
    client = createDiscordGateway("not-a-real-token", buildGraph());
    const intents = client.options.intents;

    expect(intents.has(GatewayIntentBits.DirectMessages)).toBe(true);
    expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
    // Requesting a privileged intent the app isn't approved for fails login outright.
    // DM-only doesn't need it: Discord exempts DMs from the Message Content intent.
    expect(intents.has(GatewayIntentBits.MessageContent)).toBe(false);
  });
});

/**
 * Phase 15.1. `resolveUser` mints a principal on first contact, so an unknown
 * Discord account that simply talked used to become a SECOND Ward — and `/link`
 * then refused its code, because moving a principal that already holds an
 * authorization record is a silent ledger merge. Nothing may be minted until the
 * account says which it is.
 */
describe("first contact", () => {
  test("ordinary conversation from an unknown account does not opt in", () => {
    for (const text of ["hi", "hello", "what can you do?", "swap $20 usdc for eth", "moderate"]) {
      expect(OPT_IN.test(text)).toBe(false);
    }
  });

  test("the phrase the prompt tells them to use does opt in", () => {
    for (const text of ["set me up", "Set me up", "ok set me up please", "sign me up"]) {
      expect(OPT_IN.test(text)).toBe(true);
    }
  });
});

/**
 * A malformed command payload fails silently — Discord rejects the registration and
 * the only symptom is autocomplete that never appears.
 */
describe("slash commands", () => {
  test("registers the identity commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("link");
    expect(names).toContain("unlink");
    expect(names).toContain("whoami");
  });

  test("every command is a chat-input command with a description", () => {
    for (const command of SLASH_COMMANDS) {
      expect(command).toHaveProperty("type", ApplicationCommandType.ChatInput);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("/link takes an optional code, so it can both mint and redeem", () => {
    const link = SLASH_COMMANDS.find((c) => c.name === "link");
    expect(link?.options?.[0]).toMatchObject({ name: "code", required: false });
  });
});

describe("the adapter", () => {
  interface FakeSent {
    content: string;
    hasComponents: boolean;
  }

  function fakeChannel(): { channel: SendableChannels; sent: FakeSent[]; typing: number } {
    const sent: FakeSent[] = [];
    const state = { typing: 0 };
    const channel = {
      async send(payload: string | { content: string; components?: unknown[] }) {
        const content = typeof payload === "string" ? payload : payload.content;
        const hasComponents = typeof payload !== "string" && (payload.components?.length ?? 0) > 0;
        sent.push({ content, hasComponents });
        return {
          id: String(sent.length - 1),
          async edit() {},
          createMessageComponentCollector() {
            return { on() {}, stop() {} };
          },
        };
      },
      async sendTyping() {
        state.typing++;
      },
    };
    return {
      channel: channel as unknown as SendableChannels,
      sent,
      get typing() {
        return state.typing;
      },
    };
  }

  test("carries Discord's 2000-character limit, not Telegram's 4096", () => {
    const { channel } = fakeChannel();
    const adapter = discordAdapter(channel, "551234567890123456");
    expect(adapter.channel).toBe("discord");
    expect(adapter.limit).toBe(2000);
  });

  test("truncates to the channel limit rather than throwing at the API", async () => {
    const { channel, sent } = fakeChannel();
    const adapter = discordAdapter(channel, "551234567890123456");

    await adapter.send("x".repeat(5000), "rendered");
    expect(sent[0]?.content).toHaveLength(2000);
  });

  test("sends markdown untouched — Discord renders it natively", async () => {
    const { channel, sent } = fakeChannel();
    const adapter = discordAdapter(channel, "551234567890123456");

    const markdown = "**bold** and `code` and [link](https://basescan.org/tx/0x1)";
    await adapter.send(markdown, "rendered");

    // No HTML conversion, unlike the Telegram adapter.
    expect(sent[0]?.content).toBe(markdown);
    expect(sent[0]?.content).not.toContain("<b>");
  });

  test("a confirmation is posted with buttons attached", async () => {
    const { channel, sent } = fakeChannel();
    const adapter = discordAdapter(channel, "551234567890123456");

    // The collector in the fake never fires, so this resolves only via the promise
    // we drop — assert the message shape rather than awaiting a decision.
    void adapter.askConfirm("Swap $20. Confirm?");
    await Promise.resolve();

    expect(sent[0]?.content).toMatch(/confirm/i);
    expect(sent[0]?.hasComponents).toBe(true);
  });
});
