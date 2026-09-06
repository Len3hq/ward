import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { resetBackend } from "../memory/backend.ts";
import { initialize } from "../memory/index.ts";
import { clearChannels } from "../src/gateway/channels.ts";
import { startLinkServer, type LinkServerConfig } from "../src/http/server.ts";
import { resolveUser } from "../src/identity/index.ts";
import { resetMcpRateLimit } from "../src/mcp/http.ts";
import { issueToken, revokeAllTokens } from "../src/mcp/token.ts";

/**
 * Phase 16.1 — the MCP surface over HTTP.
 *
 * A real `Client` over a real `StreamableHTTPClientTransport` against a real
 * `Bun.serve`: the transport is the thing under test, so an in-memory shortcut would
 * test nothing. What matters most here is what the endpoint refuses, because unlike
 * the linking routes this one reads user data.
 */

const CONFIG: LinkServerConfig = { publicUrl: "http://localhost", discordOAuth: undefined };
const TG = "700100200";

let dir = "";
let server: { port: number; stop(): void } | undefined;
let token = "";
let userId = "";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ward-mcp-http-"));
  process.env.WARD_MEMORY_DIR = dir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  await resetBackend();
  clearChannels();
  resetMcpRateLimit();

  ({ userId } = await resolveUser("telegram", TG));
  await initialize(userId, {
    risk_label: "moderate",
    per_action_limit_usd: 50,
    daily_limit_usd: 100,
  });
  token = await issueToken(userId);
  server = startLinkServer(CONFIG, 0);
});

afterEach(async () => {
  server?.stop();
  server = undefined;
  await resetBackend();
  clearChannels();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

function endpoint(): URL {
  return new URL(`http://localhost:${server!.port}/mcp`);
}

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  );
  return client;
}

describe("a real MCP client over HTTP", () => {
  test("connects and lists the same tools as the stdio server", async () => {
    const client = await connect(token);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "ward_link_status",
        "ward_propose_action",
        "ward_read_authorization",
        "ward_recent_activity",
        "ward_whoami",
      ]);
    } finally {
      await client.close();
    }
  });

  test("adds no way to spend — 16.1 is transport, not authority", async () => {
    const client = await connect(token);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => /execute|swap|pay|send|transfer|approve/i.test(n))).toEqual([]);
    } finally {
      await client.close();
    }
  });

  test("reads the caller's own authorization record", async () => {
    const client = await connect(token);
    try {
      const result = (await client.callTool({
        name: "ward_read_authorization",
        arguments: {},
      })) as {
        isError?: boolean;
        content: Array<{ text?: string }>;
      };
      const body = result.content.map((c) => c.text ?? "").join("\n");
      expect(result.isError).not.toBe(true);
      expect(body).toContain("100");
      expect(body).toContain("moderate");
    } finally {
      await client.close();
    }
  });
});

describe("what the endpoint refuses", () => {
  async function post(headers: Record<string, string>): Promise<Response> {
    return fetch(endpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  }

  test("no token at all", async () => {
    expect((await post({})).status).toBe(401);
  });

  test("a token Ward never issued", async () => {
    expect((await post({ authorization: "Bearer wardmcp_nope" })).status).toBe(401);
  });

  test("a revoked token stops working", async () => {
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200);
    await revokeAllTokens(userId);
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401);
  });

  /**
   * An unknown token and a revoked one must be indistinguishable, or the endpoint
   * tells a prober which of their guesses was once real.
   */
  test("unknown and revoked are the same refusal, byte for byte", async () => {
    const unknown = await post({ authorization: "Bearer wardmcp_nope" });
    await revokeAllTokens(userId);
    const revoked = await post({ authorization: `Bearer ${token}` });

    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.text()).toBe(await unknown.text());
  });

  test("a malformed Authorization header is not treated as a token", async () => {
    expect((await post({ authorization: token })).status).toBe(401); // no "Bearer "
    expect((await post({ authorization: "Basic abc" })).status).toBe(401);
  });

  test("never caches a body describing someone's caps", async () => {
    const response = await post({ authorization: `Bearer ${token}` });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("other paths are still not the MCP endpoint", async () => {
    const response = await fetch(`http://localhost:${server!.port}/mcp/anything`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});
