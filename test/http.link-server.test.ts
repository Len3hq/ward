import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetBackend } from "../memory/backend.ts";
import { initialize, readLinkCode } from "../memory/index.ts";
import type { LinkServerConfig } from "../src/http/server.ts";
import { clearChannels, registerChannel } from "../src/gateway/channels.ts";
import { authorizeUrl, redirectUri, startLinkServer } from "../src/http/server.ts";
import { resolveExisting, resolveUser } from "../src/identity/index.ts";
import { mintLinkState, redeemLinkState } from "../src/identity/linking.ts";

/**
 * Phase 15.2. The callback is the only route in Ward that can change who a channel
 * account belongs to, so what matters is what it REFUSES: a state it never minted,
 * a state it already burnt, an expired one, and an account that already has its own
 * funded Ward.
 *
 * The Discord round-trip itself is not exercised here — a token exchange against
 * Discord is not a unit test. Everything on Ward's side of it is.
 */

const OAUTH: LinkServerConfig = {
  publicUrl: "https://ward.example",
  discordOAuth: { clientId: "1545878650518511640", clientSecret: "not-a-real-secret" },
};

const TG = "700100200";
const DISCORD_ACCOUNT = "1234567890123456789";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-http-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
  clearChannels();
});

afterEach(async () => {
  await resetBackend();
  clearChannels();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function onboardedTelegramUser(): Promise<string> {
  const { userId } = await resolveUser("telegram", TG);
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  return userId;
}

describe("the authorize URL", () => {
  test("asks for a user install, so there is no server to invite the bot to", () => {
    const url = new URL(authorizeUrl(OAUTH, "some-state-value-that-is-long"));

    // integration_type=1 is the whole reason this flow beats the code flow.
    expect(url.searchParams.get("integration_type")).toBe("1");
    expect(url.searchParams.get("scope")).toContain("identify");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
  });

  test("carries the state and a redirect that matches the callback route", () => {
    const url = new URL(authorizeUrl(OAUTH, "abcdefghijklmnopqrstuvwxyz"));

    expect(url.searchParams.get("state")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri(OAUTH));
    expect(redirectUri(OAUTH)).toBe("https://ward.example/link/discord/callback");
  });

  test("never carries the client secret", () => {
    expect(authorizeUrl(OAUTH, "abcdefghijklmnopqrstuvwxyz")).not.toContain(
      OAUTH.discordOAuth!.clientSecret,
    );
  });
});

describe("the state", () => {
  test("is stored only as a hash — the state itself is not even a valid key", async () => {
    const userId = await onboardedTelegramUser();
    const { state } = await mintLinkState(userId, "telegram");

    // The store only accepts a sha256 digest as a link-code key, so a raw state
    // cannot address the record it minted — the plaintext is never written.
    expect(readLinkCode(state)).rejects.toThrow(/sha256/);
  });

  test("links the Discord account to the minting principal", async () => {
    const userId = await onboardedTelegramUser();
    const { state } = await mintLinkState(userId, "telegram");

    const result = await redeemLinkState(state, "discord", DISCORD_ACCOUNT);

    expect(result.ok).toBe(true);
    expect(await resolveExisting("discord", DISCORD_ACCOUNT)).toBe(userId);
  });

  test("works exactly once", async () => {
    const userId = await onboardedTelegramUser();
    const { state } = await mintLinkState(userId, "telegram");

    expect((await redeemLinkState(state, "discord", DISCORD_ACCOUNT)).ok).toBe(true);
    const second = await redeemLinkState(state, "discord", "9999999999999999999");
    expect(second).toMatchObject({ ok: false, reason: "already_used" });
  });

  test("expires", async () => {
    const userId = await onboardedTelegramUser();
    const { state } = await mintLinkState(userId, "telegram");

    const later = new Date(Date.now() + 6 * 60 * 1000);
    expect(await redeemLinkState(state, "discord", DISCORD_ACCOUNT, later)).toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  test("a state Ward never minted is unknown, not an error", async () => {
    const result = await redeemLinkState(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "discord",
      DISCORD_ACCOUNT,
    );
    expect(result).toMatchObject({ ok: false, reason: "unknown" });
  });

  test("a link code cannot be redeemed as a state, or the reverse", async () => {
    const userId = await onboardedTelegramUser();
    const { state } = await mintLinkState(userId, "telegram");

    // Separate hash namespaces: the same string in the wrong door finds nothing.
    const { redeemLinkCode } = await import("../src/identity/linking.ts");
    expect(await redeemLinkCode(state, "discord", DISCORD_ACCOUNT)).toMatchObject({ ok: false });
  });
});

describe("the server", () => {
  test("redirects a minted state to Discord and serves nothing else", async () => {
    const server = startLinkServer(OAUTH, 0);
    try {
      const base = `http://localhost:${server.port}`;

      const redirect = await fetch(`${base}/link/discord/abcdefghijklmnopqrstuvwxyz`, {
        redirect: "manual",
      });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toContain("discord.com/oauth2/authorize");

      // No API surface: nothing here reads or writes anything but one link.
      expect((await fetch(`${base}/nothing-here`)).status).toBe(404);
      expect((await fetch(`${base}/link/discord/callback`)).status).toBe(200); // renders "not linked"
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("a callback with no code changes nothing", async () => {
    const server = startLinkServer(OAUTH, 0);
    try {
      const response = await fetch(
        `http://localhost:${server.port}/link/discord/callback?state=abcdefghijklmnopqrstuvwxyz`,
      );
      expect(await response.text()).toContain("incomplete");
      expect(await resolveExisting("discord", DISCORD_ACCOUNT)).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("responses are never cached — a shared browser must not show the next person", async () => {
    const server = startLinkServer(OAUTH, 0);
    try {
      const response = await fetch(`http://localhost:${server.port}/link/discord/callback`);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      server.stop();
    }
  });
});

describe("the phishing backstop still fires", () => {
  test("a browser-linked account is announced on the origin channel", async () => {
    const userId = await onboardedTelegramUser();
    const told: string[] = [];
    registerChannel("telegram", {
      async notify(_accountId, text) {
        told.push(text);
      },
      async adapterFor() {
        return null;
      },
    });

    const { state } = await mintLinkState(userId, "telegram");
    const result = await redeemLinkState(state, "discord", DISCORD_ACCOUNT);
    expect(result.ok).toBe(true);

    const { announceLink } = await import("../src/identity/commands.ts");
    if (result.ok) await announceLink(result, "discord", DISCORD_ACCOUNT);

    expect(told).toHaveLength(1);
    expect(told[0]).toContain("/unlink discord");
  });
});

describe("the landing page", () => {
  test("is served at the root, and is the only cacheable route", async () => {
    const server = startLinkServer(OAUTH, 0);
    try {
      const base = `http://localhost:${server.port}`;

      const response = await fetch(`${base}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      // It names no principal and carries no link state, so unlike every other
      // page here it is safe to cache.
      expect(response.headers.get("cache-control")).toContain("max-age");

      const body = await response.text();
      // The CTA has to reach the real bot, not t.me's front page.
      expect(body).toContain("https://t.me/WardLen3bot");
      // The bundle is self-contained: no CDN fetch at runtime.
      expect(body).toContain('type="__bundler/manifest"');

      // The favicon rides inline, so the page still has its icon opened off disk.
      expect(body).toContain('rel="icon" type="image/svg+xml" href="data:image/svg+xml,');

      // Gzip is negotiated, not forced.
      const plain = await fetch(`${base}/index.html`, {
        headers: { "accept-encoding": "identity" },
      });
      expect(plain.status).toBe(200);
    } finally {
      server.stop();
    }
  });

  test("serves its icons, and nothing else out of public/", async () => {
    const server = startLinkServer(OAUTH, 0);
    try {
      const base = `http://localhost:${server.port}`;

      const svg = await fetch(`${base}/favicon.svg`);
      expect(svg.status).toBe(200);
      expect(svg.headers.get("content-type")).toBe("image/svg+xml");

      const png = await fetch(`${base}/apple-touch-icon.png`);
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toBe("image/png");

      // An allowlist, not a static directory: the page itself is the only other
      // file reachable, and only at `/`.
      expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
      expect((await fetch(`${base}/../src/config.ts`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
