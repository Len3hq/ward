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
  /**
   * What the endpoint can do something with: a ticker, a contract address, or
   * either. Checked BEFORE paying — an endpoint that searches projects by name
   * cannot use a 0x address, and finding that out costs a real payment otherwise.
   */
  subject_kind: z.enum(["ticker", "address", "any"]).default("any"),
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
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Whether this endpoint can use the subject the user gave, and what to say if not.
 *
 * "analyse the whale flow of this token 0x88Fb…e196" was sent to a project SEARCH
 * that takes a ticker or a name, with the address filled into its `ticker` field.
 * The endpoint answered 502 — after being paid. One question beforehand is cheaper
 * than one payment afterwards.
 */
export function subjectMismatch(endpoint: X402Endpoint, subject: string): string | null {
  const isAddress = EVM_ADDRESS.test(subject.trim());
  if (endpoint.subject_kind === "ticker" && isAddress) {
    return (
      `"${endpoint.name}" looks things up by ticker or project name, not by contract address. ` +
      "Give me a symbol (AERO, DEGEN) and I'll ask it that."
    );
  }
  if (endpoint.subject_kind === "address" && !isAddress) {
    return (
      `"${endpoint.name}" needs a contract address on Base, not a ticker. ` +
      `Give me the 0x… address for ${subject}.`
    );
  }
  return null;
}

/**
 * True if the endpoint's url or body_template needs a token/subject to be usable.
 *
 * Walks the whole body, not just its top level — a placeholder nested inside an
 * object or an array is still a placeholder, and reporting "no subject needed" for
 * one means asking the endpoint about an empty string, after paying it.
 */
export function endpointNeedsSubject(endpoint: X402Endpoint): boolean {
  if (PLACEHOLDER.test(endpoint.url)) return true;
  const needs = (value: unknown): boolean => {
    if (typeof value === "string") return PLACEHOLDER.test(value);
    if (Array.isArray(value)) return value.some(needs);
    if (value !== null && typeof value === "object") return Object.values(value).some(needs);
    return false;
  };
  return !!endpoint.body_template && needs(endpoint.body_template);
}

/** How far back `{date_from}` reaches. A week reads as "recently" for every entry using it. */
const LOOKBACK_DAYS = 7;

/**
 * Turn a catalog entry + the token the user asked about into a concrete call.
 * `{subject}` / `{token}` placeholders in the url (any method) and in every
 * string leaf of `body_template` (POST/PUT/PATCH) are replaced with `subject`.
 *
 * `{date_from}` / `{date_to}` become a rolling window ending now. Several Nansen
 * endpoints *require* a date range, and a literal one baked into the catalogue would
 * silently rot: the entry would keep paying and keep returning a slice of last year.
 */
export function resolveX402Call(
  endpoint: X402Endpoint,
  subject?: string,
  now: Date = new Date(),
): ResolvedX402Call {
  const sub = (subject ?? "").trim();
  const to = now.toISOString();
  const from = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const fill = (s: string): string =>
    s
      .replace(/\{(?:subject|token)\}/g, sub)
      .replace(/\{date_from\}/g, from)
      .replace(/\{date_to\}/g, to);

  const method = endpoint.method.toUpperCase();
  const url = fill(endpoint.url);

  if (method === "GET" || method === "HEAD" || !endpoint.body_template) {
    return { url, method };
  }

  // Recursive, because the placeholders that matter are NOT at the top level. Every
  // Nansen entry needing a date carries it as `{"date": {"from": "{date_from}"}}`, and
  // a one-level walk passed that straight through — the endpoint would have been paid
  // and then answered 400 on a literal "{date_from}". Arrays too: `order_by` is a list
  // of objects.
  const fillDeep = (value: unknown): unknown => {
    if (typeof value === "string") return fill(value);
    if (Array.isArray(value)) return value.map(fillDeep);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fillDeep(v)]),
      );
    }
    return value;
  };
  const body = fillDeep(endpoint.body_template) as Record<string, unknown>;
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
  return (await rankCatalog(query))[0]?.endpoint ?? null;
}

export interface RankedEndpoint {
  endpoint: X402Endpoint;
  score: number;
}

/**
 * Every endpoint that matches, best first.
 *
 * One best match was the wrong shape for a catalogue this size. With twelve Nansen
 * entries beside the three others, "smart money on base" has half a dozen honest
 * answers at three different prices, and picking one silently means the user pays for
 * whichever happened to score highest — measurably the WRONG one, since the older
 * entry usually wins on shared tags. `confirm` offers the close ones instead.
 */
export async function rankCatalog(query: string, limit = 4): Promise<RankedEndpoint[]> {
  const endpoints = await loadCatalog();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  const scored: RankedEndpoint[] = [];
  for (const endpoint of endpoints) {
    const name = endpoint.name.toLowerCase();
    const haystack = `${name} ${endpoint.description} ${endpoint.tags.join(" ")}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // The name is the strongest signal, and it is how a user picks from a list:
      // answering "nansen token holders" must beat everything that merely tags it.
      if (name.includes(term)) score += 5;
      else if (endpoint.tags.some((tag) => tag.toLowerCase().includes(term))) score += 3;
      else if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ endpoint, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.endpoint.id.localeCompare(b.endpoint.id))
    .slice(0, limit);
}

/**
 * Is the top match clear enough to act on without asking?
 *
 * A decisive lead means the user named the thing. A near-tie means several endpoints
 * answer the question they actually asked, and choosing for them spends their money
 * on a guess.
 */
export function isAmbiguous(ranked: RankedEndpoint[]): boolean {
  return ranked.length > 1 && ranked[1]!.score >= ranked[0]!.score - 1;
}
