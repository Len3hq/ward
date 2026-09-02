import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/**
 * Static x402 endpoint catalog + keyword discovery. Adapted from Len3's
 * `catalog_provider.py` (env-driven catalog) — the pgvector hybrid search is
 * replaced by substring/keyword match over `memory/catalog/x402-catalog.json`.
 */

const endpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  url: z.string(),
  method: z.string().default("GET"),
  cost_usd: z.number().nonnegative(),
  tags: z.array(z.string()).default([]),
});
export type X402Endpoint = z.infer<typeof endpointSchema>;

const catalogFileSchema = z.object({ endpoints: z.array(endpointSchema) });

let cache: X402Endpoint[] | null = null;

function catalogPath(): string {
  return (
    process.env.WARD_X402_CATALOG?.trim() ||
    path.join(import.meta.dir, "..", "..", "memory", "catalog", "x402-catalog.json")
  );
}

export async function loadCatalog(): Promise<X402Endpoint[]> {
  if (cache) return cache;
  const raw: unknown = JSON.parse(await readFile(catalogPath(), "utf8"));
  cache = catalogFileSchema.parse(raw).endpoints;
  return cache;
}

/** Test hook. */
export function resetCatalog(): void {
  cache = null;
}

/** Best keyword match, or `null`. Scores name/description/tag hits from the query terms. */
export async function searchCatalog(query: string): Promise<X402Endpoint | null> {
  const endpoints = await loadCatalog();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return null;

  let best: { endpoint: X402Endpoint; score: number } | null = null;
  for (const endpoint of endpoints) {
    const haystack =
      `${endpoint.name} ${endpoint.description} ${endpoint.tags.join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (endpoint.tags.some((tag) => tag.toLowerCase().includes(term))) score += 3;
      else if (haystack.includes(term)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { endpoint, score };
  }
  return best?.endpoint ?? null;
}
