import { describe, expect, test } from "bun:test";

import { SLASH_COMMANDS } from "../src/discord/gateway.ts";
import {
  BOT_COMMANDS,
  COMMANDS,
  commandArgument,
  isIdentityCommand,
  resolveCommand,
} from "../src/gateway/commands.ts";
import { HELP, welcome } from "../src/gateway/help.ts";

/**
 * The table exists so that a subcommand can be found without already knowing it, and
 * so that the menu, the handlers and the help cannot drift apart. Both are properties
 * worth asserting: the first is why `/link_mcp` exists at all, and the second is the
 * bug the table replaced — three lists in three files with nothing making them agree.
 */

describe("what the two apps will actually accept", () => {
  test("every name is one word that both Telegram and Discord will register", () => {
    for (const { name } of COMMANDS) {
      expect(name, `${name} must be lowercase, one word, underscores only`).toMatch(
        /^[a-z0-9_]{1,32}$/,
      );
      expect(name).not.toContain(" ");
    }
  });

  /** Telegram allows 256, Discord only 100. One description has to satisfy both. */
  test("every description fits Discord's 100-character limit", () => {
    for (const { name, description } of COMMANDS) {
      expect(
        [...description].length,
        `${name}'s description is too long for Discord`,
      ).toBeLessThanOrEqual(100);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  test("no two rows claim the same name", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The whole point of the underscore names. A user who has never read the docs types
 * "/" and has to be able to see how to connect a coding client and how to stop one
 * spending — the two things that were previously reachable only as second words.
 */
describe("the things you could not find before", () => {
  const menu = BOT_COMMANDS.map((c) => c.command);

  test("connecting a coding client is in the menu", () => {
    expect(menu).toContain("link_mcp");
  });

  test("linking the other chat app is in the menu", () => {
    expect(menu).toContain("link_discord");
  });

  test("granting and stopping a client are both in the menu", () => {
    expect(menu).toContain("mcp_grant");
    expect(menu).toContain("mcp_stop");
  });

  test("no advertised command needs a second word to do anything", () => {
    for (const command of menu) {
      const spec = resolveCommand(command)!;
      // Either the row carries its own subcommand, or the bare handler is the feature.
      expect(spec.argument === undefined || spec.argument.length > 0).toBe(true);
    }
  });
});

describe("resolving and dispatching", () => {
  test("a name resolves with or without its slash, and with an @mention", () => {
    expect(resolveCommand("link_mcp")?.name).toBe("link_mcp");
    expect(resolveCommand("/link_mcp")?.name).toBe("link_mcp");
    expect(resolveCommand("/link_mcp@ward_bot")?.name).toBe("link_mcp");
    expect(resolveCommand("/LINK_MCP")?.name).toBe("link_mcp");
  });

  test("an unknown command resolves to nothing rather than to a wrong handler", () => {
    expect(resolveCommand("link_carrier_pigeon")).toBeUndefined();
    expect(resolveCommand("")).toBeUndefined();
  });

  /** The alias has to become exactly the string the spaced form already sent. */
  test("an alias rebuilds the argument the old subcommand produced", () => {
    const grant = resolveCommand("mcp_grant")!;
    expect(commandArgument(grant, "a3f9c2d1 data 0.5 2 7")).toBe("grant a3f9c2d1 data 0.5 2 7");
    expect(commandArgument(grant, "")).toBe("grant");

    const linkMcp = resolveCommand("link_mcp")!;
    expect(commandArgument(linkMcp, "")).toBe("mcp");

    // A row with no argument of its own passes the user's text straight through.
    const link = resolveCommand("link")!;
    expect(commandArgument(link, "WARD-ABCD")).toBe("WARD-ABCD");
    expect(commandArgument(link, "")).toBe("");
  });

  test("the spaced forms still resolve, because Ward has already told people to send them", () => {
    // `/mcp grant …` arrives as the `mcp` row with "grant …" typed after it.
    const mcp = resolveCommand("mcp")!;
    expect(commandArgument(mcp, "grant a3f9c2d1 data 0.5 2 7")).toBe("grant a3f9c2d1 data 0.5 2 7");
  });
});

/**
 * Discord cannot deliver an interaction for a command it never registered, so a name
 * Ward tells someone to send has to be in Discord's list even when Telegram's curated
 * menu leaves it out. `/mcp_confirm` is the one that bites: it is only ever reached by
 * following an instruction Ward just printed.
 */
describe("Discord registers what Ward tells people to send", () => {
  const registered = SLASH_COMMANDS.map((c) => c.name);

  test("every routable command except /start is registered", () => {
    for (const { name, base } of COMMANDS) {
      if (base === "start") continue;
      expect(registered, `/${name} is routable but Discord cannot send it`).toContain(name);
    }
    expect(registered).not.toContain("start");
  });

  test("the follow-up commands Ward prints are all sendable", () => {
    for (const name of ["mcp_confirm", "mcp_revoke", "mcp_tokens", "mcp_grants", "unlink_mcp"]) {
      expect(registered).toContain(name);
    }
  });

  test("commands that read an argument offer one, and it says what to type", () => {
    for (const name of ["link", "unlink", "mcp_grant"]) {
      const command = SLASH_COMMANDS.find((c) => c.name === name);
      expect(command?.options?.[0], `/${name} takes no argument`).toMatchObject({
        name: "args",
        required: false,
      });
      // "args" alone is what the old list said, and it told the user nothing.
      expect((command!.options![0] as { description: string }).description.length).toBeGreaterThan(
        10,
      );
    }
  });

  test("commands that take nothing do not ask for anything", () => {
    expect(SLASH_COMMANDS.find((c) => c.name === "whoami")?.options).toBeUndefined();
    expect(SLASH_COMMANDS.find((c) => c.name === "mcp_stop")?.options).toBeUndefined();
  });
});

/**
 * Copy and table have to agree, because the copy is what a user reads and the table is
 * what runs. Every command named in the help or the welcome must be one Ward answers.
 */
test("every command quoted in the help and the welcome actually exists", () => {
  const quoted = new Set<string>();
  for (const text of [HELP, welcome("telegram"), welcome("discord")]) {
    for (const match of text.matchAll(/\/([a-z][a-z0-9_]*)/g)) quoted.add(match[1]!);
  }
  expect(quoted.size).toBeGreaterThan(8);
  for (const name of quoted) {
    expect(resolveCommand(name), `the copy names /${name}, which nothing handles`).toBeDefined();
  }
});

test("the identity commands are exactly the four that resolve a principal", () => {
  const identity = COMMANDS.filter((c) => isIdentityCommand(c.base)).map((c) => c.base);
  expect(new Set(identity)).toEqual(new Set(["link", "mcp", "unlink", "whoami"]));
});
