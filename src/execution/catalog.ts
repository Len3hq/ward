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
  method: z
    .string()
    .default("GET")
    .transform((m) => m.toUpperCase()),
  /**
   * JSON body for POST/PUT/PATCH endpoints. String leaves containing `{subject}`
   * or `{token}` are filled with the token the user asked about (see
   * `resolveX402Call`). Ignored for GET/HEAD.
   */
  body_template: z.record(z.string(), z.unknown()).optional(),
  cost_usd: z.number().nonnegative(),
  tags: z.array(z.string()).default([]),
});
export type X402Endpoint = z.infer<typeof endpointSchema>;

/** A concrete HTTP call, ready for the wallet provider. */
export interface ResolvedX402Call {
  url: string;
  method: string;
  /** Present only for POST/PUT/PATCH endpoints with a `body_template`. */
  body?: Record<string, unknown>;
}

const PLACEHOLDER = /\{(?:subject|token)\}/;

/** True if the endpoint's url or body_template needs a token/subject to be usable. */
export function endpointNeedsSubject(endpoint: X402Endpoint): boolean {
  if (PLACEHOLDER.test(endpoint.url)) return true;
  return (
    !!endpoint.body_template &&
    Object.values(endpoint.body_template).some((v) => typeof v === "string" && PLACEHOLDER.test(v))
  );
}

/**
 * Turn a catalog entry + the token the user asked about into a concrete call.
 * `{subject}` / `{token}` placeholders in the url (any method) and in every
 * string leaf of `body_template` (POST/PUT/PATCH) are replaced with `subject`.
 */
export function resolveX402Call(endpoint: X402Endpoint, subject?: string): ResolvedX402Call {
  const sub = (subject ?? "").trim();
  const fill = (s: string): string => s.replace(/\{(?:subject|token)\}/g, sub);

  const method = endpoint.method.toUpperCase();
  const url = fill(endpoint.url);

  if (method === "GET" || method === "HEAD" || !endpoint.body_template) {
    return { url, method };
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(endpoint.body_template)) {
    body[key] = typeof value === "string" ? fill(value) : value;
  }
  return { url, method, body };
}

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
