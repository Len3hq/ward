import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { MemoryBackend } from "../backend.ts";
import type { JournalEvent } from "../schema.ts";

/**
 * Sibyl Memory backend — the judged persistence path.
 *
 * Spawns the `sibyl-memory-mcp` server (stdio) and drives it with the `memory_*`
 * tools. Setup, once per machine:
 *
 *   pip install 'sibyl-memory-cli[mcp]'     # Python 3.10+
 *   sibyl init                               # browser activation (email or wallet)
 *   sibyl status                             # confirm tier + DB location
 *
 * The server also runs **unactivated** against a local SQLite DB (tenant
 * `00000000-…-0001`); `sibyl init` unlocks the Pro tier and sync.
 *
 * Env:
 *   SIBYL_MEMORY_MCP_COMMAND   server binary (default "sibyl-memory-mcp")
 *   SIBYL_MEMORY_DB            SQLite path   (default ~/.sibyl-memory/memory.db)
 *   SIBYL_CREDENTIALS          credentials   (default ~/.sibyl-memory/credentials.json)
 *
 * ── Wire contract (verified against sibyl-memory-mcp 0.2.0 via tools/list) ──────
 *   memory_recall      { category, name }           → { ok, entity: { body, … } }  · isError NOT_FOUND when absent
 *   memory_remember    { category, name, body }     → { ok, category, name }
 *   memory_record_event{ kind, body, category?, name? } → { ok, event_id, kind }
 *   memory_get_state   { key }                      → { ok, body, … }  ·  { ok: false, code: "NOT_FOUND" } when absent
 *   memory_set_state   { key, body }                → { ok, key }
 *   memory_forget      { category, name, reason? }  → { ok, archived: { … } }
 * Recall/get_state results also carry `_untrusted_context` (Sibyl's injection
 * guard on stored values) — handled where memory content reaches the LLM, not here.
 */

const TOOL = {
  recall: "memory_recall",
  remember: "memory_remember",
  recordEvent: "memory_record_event",
  getState: "memory_get_state",
  setState: "memory_set_state",
  forget: "memory_forget",
} as const;

export class SibylMcpBackend implements MemoryBackend {
  #client: Client | null = null;
  #connecting: Promise<Client> | null = null;

  async #connected(): Promise<Client> {
    if (this.#client) return this.#client;
    this.#connecting ??= this.#connect();
    this.#client = await this.#connecting;
    return this.#client;
  }

  async #connect(): Promise<Client> {
    const command = process.env.SIBYL_MEMORY_MCP_COMMAND?.trim() || "sibyl-memory-mcp";
    const env: Record<string, string> = {};
    for (const key of ["SIBYL_MEMORY_DB", "SIBYL_CREDENTIALS", "SIBYL_TENANT_ID", "PATH", "HOME"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }

    const transport = new StdioClientTransport({
      command,
      args: [],
      env,
      stderr: process.env.SIBYL_MEMORY_MCP_DEBUG ? "inherit" : "ignore",
    });
    const client = new Client({ name: "ward", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
    } catch (cause) {
      throw new Error(
        `Could not start the Sibyl Memory MCP server ("${command}"). Install it with ` +
          `\`pip install 'sibyl-memory-cli[mcp]'\` (Python 3.10+), or set ` +
          `SIBYL_MEMORY_MODE=fs for offline dev. Cause: ${errText(cause)}`,
      );
    }
    return client;
  }

  /** Raw tool call → parsed result object, or `null` for a not-found error. Throws on any other error. */
  async #call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const client = await this.#connected();
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;

    if (result.isError) {
      const message = textOf(result);
      if (isNotFound(message)) return null;
      throw new Error(`sibyl tool ${name} failed: ${message}`);
    }

    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = textOf(result);
    if (!text) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      return { value: text };
    }
  }

  async getEntity(category: string, name: string): Promise<unknown | null> {
    const res = await this.#call(TOOL.recall, { category, name });
    if (!res || res.ok === false) return null;
    const entity = res.entity as Record<string, unknown> | undefined;
    return entity?.body ?? null;
  }

  async putEntity(category: string, name: string, body: unknown): Promise<void> {
    await this.#call(TOOL.remember, { category, name, body });
  }

  async appendEvent(event: JournalEvent): Promise<void> {
    await this.#call(TOOL.recordEvent, {
      kind: event.kind,
      category: `ward.${event.kind}`,
      body: { ts: event.ts, tg_id: event.tg_id, summary: event.summary, ...event.detail },
    });
  }

  async getState(key: string): Promise<unknown | null> {
    const res = await this.#call(TOOL.getState, { key });
    if (!res || res.ok === false) return null;
    return res.body ?? null;
  }

  async setState(key: string, body: unknown): Promise<void> {
    await this.#call(TOOL.setState, { key, body });
  }

  async forgetEntity(category: string, name: string, reason?: string): Promise<void> {
    await this.#call(TOOL.forget, { category, name, reason: reason ?? null });
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connecting = null;
    await client?.close();
  }
}

// --- result parsing ---

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isNotFound(message: string): boolean {
  return /not[\s_-]?found|NOT_FOUND|NotFoundError|no such|does not exist/i.test(message);
}

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
