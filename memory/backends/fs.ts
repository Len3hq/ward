import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MemoryBackend } from "../backend.ts";
import type { JournalEvent } from "../schema.ts";

/**
 * Hermetic JSON-file backend for unit tests and offline dev. **Not the judged
 * path** — the real store is Sibyl Memory (`backends/sibyl-mcp.ts`). Selected with
 * `SIBYL_MEMORY_MODE=fs`.
 *
 *   <root>/users/<name>/<category-leaf>.json   one file per entity
 *   <root>/journal.ndjson                       append-only COLD journal (all users)
 *   <root>/state/<key>.json                     HOT state documents
 *
 * `<root>` is `WARD_MEMORY_DIR` or this `memory/` directory. Writes are atomic
 * (temp file + rename); the journal is a plain append.
 */
export class FsBackend implements MemoryBackend {
  #root(): string {
    return process.env.WARD_MEMORY_DIR?.trim() || path.join(import.meta.dir, "..");
  }

  #entityPath(category: string, name: string): string {
    const leaf = category.split(".").pop() ?? category;
    return path.join(this.#root(), "users", name, `${leaf}.json`);
  }

  #statePath(key: string): string {
    return path.join(this.#root(), "state", `${key}.json`);
  }

  async getEntity(category: string, name: string): Promise<unknown | null> {
    return readJsonIfExists(this.#entityPath(category, name));
  }

  async putEntity(category: string, name: string, body: unknown): Promise<void> {
    await atomicWrite(this.#entityPath(category, name), serialize(body));
  }

  async forgetEntity(category: string, name: string): Promise<void> {
    await rm(this.#entityPath(category, name), { force: true });
  }

  async appendEvent(event: JournalEvent): Promise<void> {
    const file = path.join(this.#root(), "journal.ndjson");
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  }

  async getState(key: string): Promise<unknown | null> {
    return readJsonIfExists(this.#statePath(key));
  }

  async setState(key: string, body: unknown): Promise<void> {
    await atomicWrite(this.#statePath(key), serialize(body));
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function atomicWrite(filePath: string, data: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, filePath);
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
