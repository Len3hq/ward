import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createMcpServer } from "./server.ts";
import { liveGrant } from "./grants.ts";
import { resolveToken, tokenAccountId } from "./token.ts";

/**
 * Ward's MCP surface over HTTP (Phase 16.1) — the same five tools the stdio server
 * exposes, reachable by a client that cannot spawn a local process.
 *
 * ## Why this exists
 *
 * The stdio server has to run wherever Sibyl Memory is. For a deployed Ward that is
 * inside the container, which is why testing it meant `railway ssh`. Over HTTP the
 * server *is* the running Ward process, so it shares the memory by construction.
 *
 * ## What it does NOT add
 *
 * No new tools and no new authority. `ward_propose_action` still only queues a
 * request for the user to confirm on a human channel, and there is still no tool
 * that executes. Phase 16.1 is transport only; execution is 16.3, and gated on a
 * grant that does not exist yet.
 *
 * ## A server per request
 *
 * Each request builds its own `McpServer` and transport, bound to the token in that
 * request's `Authorization` header, and closes both afterwards. Stateless mode
 * (`sessionIdGenerator: undefined`) is what makes that affordable, and it is the
 * point rather than a shortcut: a session that outlived a request would hold a
 * credential from one caller and serve another, which is exactly the bug this
 * surface must not have.
 *
 * ## Refusals say as little as possible
 *
 * A missing, unknown, revoked and expired token all get the same 401 with the same
 * body. Distinguishing them tells a prober which of their guesses was once real.
 */

/** Requests per token per minute. Human-driven clients sit far below this. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

const hits = new Map<string, number[]>();

function rateLimited(key: string, now: number): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

/** Test hook. */
export function resetMcpRateLimit(): void {
  hits.clear();
}

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

const HEADERS = { "cache-control": "no-store" } as const;

function unauthorized(): Response {
  // A JSON-RPC-shaped error, since the caller is an MCP client, plus the 401 an
  // HTTP client expects. `WWW-Authenticate` is what an MCP client looks for to know
  // it should go and get a credential.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Not authorized. Send an Authorization: Bearer wardmcp_… token minted with " +
          '"/link mcp" from Telegram or Discord.',
      },
      id: null,
    }),
    {
      status: 401,
      headers: {
        ...HEADERS,
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="ward"',
      },
    },
  );
}

/**
 * Handle one MCP request. Returns `null` for paths this does not own, so the caller
 * can carry on routing.
 */
export async function handleMcpRequest(
  request: Request,
  pathname: string,
): Promise<Response | null> {
  if (pathname !== "/mcp") return null;

  const token = bearerToken(request);
  if (!token) return unauthorized();

  // Resolve before doing any work, so an unknown token costs nothing and cannot be
  // used to probe for tool names or behaviour.
  const userId = await resolveToken(token);
  if (userId === null) return unauthorized();

  if (rateLimited(userId, Date.now())) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Too many requests. Slow down." },
        id: null,
      }),
      {
        status: 429,
        headers: { ...HEADERS, "content-type": "application/json", "retry-after": "60" },
      },
    );
  }

  // Per request, so a grant issued or revoked a moment ago takes effect on the very
  // next call — no restart, and no window where a revoked grant still lists a tool.
  const canExecute = (await liveGrant(tokenAccountId(token))) !== null;
  const server = createMcpServer(() => token, { canExecute });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: see the note above
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Never let a proxy or a shared browser cache a body describing someone's caps.
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
