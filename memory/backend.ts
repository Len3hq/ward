import { FsBackend } from "./backends/fs.ts";
import { SibylMcpBackend } from "./backends/sibyl-mcp.ts";
import type { JournalEvent } from "./schema.ts";

/**
 * The persistence primitive `store.ts` sits on. Two implementations:
 *
 * - `sibyl-mcp` (default) — the real, judged path. Talks to the `sibyl-memory-mcp`
 *   server over stdio, mapping onto Sibyl Memory's tiers:
 *     WARM entity   ← authorization record, wallet record   (getEntity / putEntity)
 *     COLD journal  ← every mutation                          (appendEvent)
 *     HOT state     ← conversation summary (Phase 7)          (getState / setState)
 *
 * - `fs` — a hermetic JSON-file backend for unit tests and offline dev. **Not the
 *   judged path.** Selected with `SIBYL_MEMORY_MODE=fs`.
 *
 * `store.ts` owns all schema validation and domain logic; a backend only moves
 * opaque JSON documents in and out.
 */
export interface MemoryBackend {
  /** `null` when the entity does not exist. */
  getEntity(category: string, name: string): Promise<unknown | null>;
  putEntity(category: string, name: string, body: unknown): Promise<void>;
  /** Remove an entity (archive on Sibyl, delete on fs). Used by the deletion-gate test. */
  forgetEntity(category: string, name: string, reason?: string): Promise<void>;

  /** Append-only. */
  appendEvent(event: JournalEvent): Promise<void>;

  /** `null` when the state document does not exist. */
  getState(key: string): Promise<unknown | null>;
  setState(key: string, body: unknown): Promise<void>;

  /** Release any child process / handles. */
  close(): Promise<void>;
}

export type MemoryMode = "sibyl-mcp" | "fs";

export function resolveMode(): MemoryMode {
  const raw = process.env.SIBYL_MEMORY_MODE?.trim();
  if (!raw || raw === "sibyl-mcp" || raw === "mcp") return "sibyl-mcp";
  if (raw === "fs") return "fs";
  throw new Error(
    `unknown SIBYL_MEMORY_MODE: ${JSON.stringify(raw)} (expected "sibyl-mcp" or "fs")`,
  );
}

let cached: MemoryBackend | null = null;

export function backend(): MemoryBackend {
  cached ??= createBackend(resolveMode());
  return cached;
}

function createBackend(mode: MemoryMode): MemoryBackend {
  return mode === "fs" ? new FsBackend() : new SibylMcpBackend();
}

/** Test hook: drop the cached backend (closing it) so the next call rebuilds it. */
export async function resetBackend(): Promise<void> {
  const current = cached;
  cached = null;
  await current?.close();
}
