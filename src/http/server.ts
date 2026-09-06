import { fileURLToPath } from "node:url";

import type { DiscordOAuthConfig } from "../config.ts";
import { notifyAccount } from "../gateway/channels.ts";
import { announceLink } from "../identity/commands.ts";
import { accountsFor } from "../identity/index.ts";
import { redeemLinkState } from "../identity/linking.ts";
import { challenge, redeemWalletSignature } from "../identity/wallet.ts";
import { handleMcpRequest } from "../mcp/http.ts";

/**
 * The linking callback server — the one thing in Ward that serves HTTP.
 *
 * It serves the landing page, and the linking flows in `MULTI-CHANNEL.md`:
 *
 * - **The landing page** — `GET /`, a static bundle in `public/index.html`. It is the
 *   only route with no user data in it and the only one that is safe to cache.
 * - **The MCP surface (Phase 16.1)** — the same five read-and-propose tools the
 *   stdio server exposes, for a client that cannot spawn a local process. It adds no
 *   authority: there is still no tool that executes. Needs only `WARD_PUBLIC_URL`.
 * - **Wallet-signature linking (Phase 14)** — the user signs a challenge with a
 *   wallet *they* control, which proves an identity Ward cannot forge and gives them
 *   a way back in if they lose the chat account. Needs only `WARD_PUBLIC_URL`.
 * - **Discord one-click (Phase 15.2)** — Discord returns the account id itself, so
 *   nobody transcribes a code and no bot has to be invited to a server first;
 *   `integration_type=1` installs the app to the *user*, which is also what lets Ward
 *   open the DM afterwards. Needs an OAuth app as well.
 *
 * `/mcp` is the one route that reads user data, and it is the reason the others are
 * worth keeping narrow: everything else here can only change which principal a
 * channel account belongs to, and only on presentation of a state Ward minted, inside
 * an authenticated DM, less than five minutes earlier. Nothing served here can move
 * money.
 *
 * Security notes, none of them optional:
 *
 * - **The `state` is a link code.** Single-use, 5-minute TTL, rate-limited, stored
 *   only as a hash — `mintLinkState` / `redeemLinkState` reuse exactly the code
 *   path's rules, including the refusal to merge two funded principals.
 * - **The result is rendered, never redirected.** A 302 onward would leak the state
 *   in a `Referer`, and the state is the credential until it is burnt.
 * - **The announcement still fires.** An account linked in a browser needs the
 *   phishing backstop more than one that typed a code, not less, so the callback
 *   goes through the same `announceLink`.
 * - **`no-store` on every response**, so a shared browser cannot show the next
 *   person a page naming someone's Ward.
 */

export interface LinkServer {
  port: number;
  stop(): void;
}

/**
 * What the server needs. `publicUrl` alone is enough for wallet linking (Phase 14);
 * Discord's routes appear only when an OAuth app is configured too.
 */
export interface LinkServerConfig {
  publicUrl: string;
  discordOAuth: DiscordOAuthConfig | undefined;
}

const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";

/**
 * The landing page. A self-contained bundle — fonts, React and every asset are
 * embedded — so it loads nothing from a CDN and nothing about it can change under
 * the deploy. Served from disk rather than compiled in, so it can be replaced
 * without touching this file; gzipped once on first request because a third of
 * 350 kB is worth not sending twice.
 */
const LANDING = fileURLToPath(new URL("../../public/index.html", import.meta.url));
let landingGzip: Uint8Array | undefined;

/** Where Discord sends the browser back. Must match the portal entry exactly. */
export function redirectUri(config: LinkServerConfig): string {
  return `${config.publicUrl}/link/discord/callback`;
}

/**
 * `scope` and `integration_type` are the whole trick. `identify` gives the account
 * id; `applications.commands` with `integration_type=1` installs the app to the
 * user rather than to a guild, so there is no server to invite Ward to — and it is
 * what makes the welcome DM deliverable.
 */
export function authorizeUrl(config: LinkServerConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.discordOAuth!.clientId,
    response_type: "code",
    redirect_uri: redirectUri(config),
    scope: "identify applications.commands",
    integration_type: "1",
    state,
  });
  return `${DISCORD_AUTHORIZE}?${params.toString()}`;
}

export function startLinkServer(config: LinkServerConfig, port: number): LinkServer {
  const server = Bun.serve({
    port,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") return text("ok");

      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/" || url.pathname === "/index.html")
      ) {
        return landing(request);
      }

      // The MCP surface (Phase 16.1). Read-and-propose only, exactly as over stdio —
      // no tool here executes anything. It owns `/mcp` and returns null otherwise.
      const mcp = await handleMcpRequest(request, url.pathname);
      if (mcp !== null) return mcp;

      // `/link/discord/<state>` — hand the browser to Discord. The state never
      // leaves Ward's own origin until Discord echoes it back.
      const wallet = /^\/link\/wallet\/([A-Za-z0-9_-]{16,})$/.exec(url.pathname);
      if (wallet) {
        if (request.method === "GET") return walletPage(wallet[1]!);
        if (request.method === "POST") return handleWallet(wallet[1]!, request);
      }

      if (config.discordOAuth) {
        const start = /^\/link\/discord\/([A-Za-z0-9_-]{16,})$/.exec(url.pathname);
        if (request.method === "GET" && start) {
          return Response.redirect(authorizeUrl(config, start[1]!), 302);
        }

        if (request.method === "GET" && url.pathname === "/link/discord/callback") {
          return handleCallback(config, url);
        }
      }

      return page("Not found", "There's nothing at this address.", 404);
    },
  });

  const routes = config.discordOAuth ? "wallet + discord" : "wallet only";
  console.log(`Ward linking server on :${server.port} (${config.publicUrl}, ${routes}).`);
  return { port: server.port ?? port, stop: () => void server.stop(true) };
}

async function handleCallback(config: LinkServerConfig, url: URL): Promise<Response> {
  // Discord reports a refusal here rather than by not calling back at all.
  const denied = url.searchParams.get("error");
  if (denied !== null) {
    return page("Not linked", "You cancelled, so nothing changed. You can try again any time.");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return page("Not linked", "That link is incomplete. Ask for a fresh one with /link discord.");
  }

  let account: { id: string; username: string };
  try {
    account = await exchange(config, code);
  } catch (error) {
    console.error("discord oauth exchange failed:", error);
    return page(
      "Not linked",
      "I couldn't confirm that with Discord. Nothing changed — ask for a fresh link with /link discord.",
    );
  }

  const result = await redeemLinkState(state, "discord", account.id);
  if (!result.ok) return page("Not linked", result.message);

  // Same backstop as the typed-code path: every other account hears about it.
  const summary = await announceLink(result, "discord", account.id);

  // The welcome DM is what makes the flow feel finished — and it only works because
  // the user just installed the app, which is the point of `integration_type=1`.
  await notifyAccount(
    "discord",
    account.id,
    `${summary}\n\nYou can talk to me right here. Try: "what am I allowed to do?"`,
  );

  return page(
    "Linked",
    `@${account.username} now reaches the Ward you set up on ${result.mintedOn} — same limits, ` +
      `same spend history, same wallet. I've sent you a DM; you can close this tab.`,
  );
}

/**
 * The signing page. Deliberately one file, no framework and no CDN: it runs in a
 * wallet browser, it is served by an agent that otherwise has no web surface, and
 * anything it loaded from elsewhere would be one more thing that can change under
 * it.
 *
 * The page never sees the principal, the caps or the spend history — only the
 * challenge. All it can do is hand back a signature.
 */
function walletPage(state: string): Response {
  const message = JSON.stringify(challenge(state));
  return html(
    `<main><h1>Link your wallet</h1>` +
      `<p>Sign a message to prove you control this wallet. This moves no funds and grants ` +
      `no spending authority — Ward can still only spend inside the Spend Permission you ` +
      `granted, and only up to the limits in its memory.</p>` +
      `<button id="go">Connect and sign</button><p id="out"></p></main>` +
      `<script>
const out = document.getElementById("out");
document.getElementById("go").addEventListener("click", async () => {
  const eth = window.ethereum;
  if (!eth) { out.textContent = "No wallet found in this browser. Open this link in your wallet's browser."; return; }
  try {
    out.textContent = "Waiting for your wallet…";
    const [address] = await eth.request({ method: "eth_requestAccounts" });
    const signature = await eth.request({ method: "personal_sign", params: [${message}, address] });
    const response = await fetch(location.pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, signature }),
    });
    out.textContent = (await response.json()).message;
    document.getElementById("go").disabled = true;
  } catch (error) {
    out.textContent = error && error.message ? error.message : "Cancelled.";
  }
});
</script>`,
  );
}

async function handleWallet(state: string, request: Request): Promise<Response> {
  let body: { address?: unknown; signature?: unknown };
  try {
    body = (await request.json()) as { address?: unknown; signature?: unknown };
  } catch {
    return json({ message: "Malformed request." }, 400);
  }
  if (typeof body.address !== "string" || typeof body.signature !== "string") {
    return json({ message: "Malformed request." }, 400);
  }

  const result = await redeemWalletSignature(state, body.address, body.signature);
  if (!result.ok) return json({ message: result.message }, 400);

  // The same phishing backstop every other route into a principal has. A wallet is a
  // *recovery* credential, so a silent enrollment is exactly the thing that must not
  // be possible: every account on the record hears about it.
  const short = `${result.address.slice(0, 6)}\u2026${result.address.slice(-4)}`;
  const news = result.enrolled
    ? `The wallet ${short} was just verified for your Ward. It can now reach this Ward even ` +
      `without a chat account.\n\nIf that wasn't you, send "/unlink wallet ${result.address}" now.`
    : `A ${result.mintedOn} account was just linked to your Ward with the wallet ${short}.` +
      `\n\nIf that wasn't you, send "/unlink ${result.mintedOn}" now.`;
  for (const account of await accountsFor(result.userId)) {
    await notifyAccount(account.channel, account.account_id, news);
  }

  return json({
    message: result.enrolled
      ? "Wallet verified. It can now reach this Ward even if you lose this chat account."
      : "Wallet verified, and this account now reaches that Ward.",
  });
}

async function landing(request: Request): Promise<Response> {
  const file = Bun.file(LANDING);
  if (!(await file.exists())) {
    return page("Ward", "The landing page isn't part of this deployment.", 404);
  }

  // Unlike every other response here, this one names no principal and carries no
  // link state, so `no-store` would only cost the visitor 350 kB on every reload.
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
    vary: "accept-encoding",
  };

  if (!request.headers.get("accept-encoding")?.includes("gzip")) {
    return new Response(file, { headers });
  }

  landingGzip ??= Bun.gzipSync(new Uint8Array(await file.arrayBuffer()));
  return new Response(landingGzip, { headers: { ...headers, "content-encoding": "gzip" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function exchange(
  config: LinkServerConfig,
  code: string,
): Promise<{ id: string; username: string }> {
  const oauth = config.discordOAuth!;
  const tokenResponse = await fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(config),
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`token exchange returned ${tokenResponse.status}`);
  }

  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
  if (!accessToken) throw new Error("no access_token in Discord's response");

  const meResponse = await fetch(DISCORD_ME, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!meResponse.ok) throw new Error(`users/@me returned ${meResponse.status}`);

  const me = (await meResponse.json()) as { id?: string; username?: string };
  if (!me.id) throw new Error("no id in Discord's user response");
  return { id: me.id, username: me.username ?? "you" };
}

function text(body: string): Response {
  return new Response(body, { headers: { "cache-control": "no-store" } });
}

/** Discord's own text is never rendered here — only Ward's — so there is no HTML to escape. */
function page(title: string, body: string, status = 200): Response {
  return html(`<main><h1>${title}</h1><p>${body}</p></main>`, status);
}

function html(inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Ward</title>` +
      `<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;` +
      `min-height:100vh;background:#0f1115;color:#e7e9ee;padding:2rem}` +
      `main{max-width:32rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.75rem 0 0;color:#a8adbb}` +
      `button{font:inherit;margin-top:1rem;padding:.6rem 1.1rem;border:0;border-radius:.5rem;` +
      `background:#4f7cff;color:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:default}</style>` +
      inner,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}
