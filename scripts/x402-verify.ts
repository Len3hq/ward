/**
 * Check every catalogue entry against its live `402` challenge. Pays nothing.
 *
 *   bun run scripts/x402-verify.ts
 *
 * A 402 serves no data and costs no money, so this is free to run and is the only
 * way to know the catalogue is still true. It exists because it wasn't true: the
 * `token-risk` endpoint had been returning `502 Bad Gateway` from its own nginx,
 * and the two Heurist endpoints charge $0.001 while the catalogue advertised $0.05
 * — the number Ward quotes in the confirmation the user approves.
 *
 * Reports, per entry: HTTP status, the price the endpoint actually asks, the asset
 * and network it wants, and whether that matches `cost_usd`.
 */
import { loadCatalog, resolveX402Call } from "../src/execution/catalog.ts";
import { loadConfig } from "../src/config.ts";
import { x402QuoteUsd } from "../src/wallet/cdp.ts";

/** A token whose address is valid everywhere, for endpoints that need a subject. */
const SAMPLE_SUBJECT = "0x4200000000000000000000000000000000000006"; // WETH on Base
const USDC: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * What the endpoint would object to in the body we intend to send, judged against the
 * example body it publishes in its own 402 (`extensions.bazaar`).
 *
 * Free, and the only pre-payment check there is: Nansen validates the body only after
 * taking the money, so every shape mistake otherwise costs a purchase to find.
 */
function bodyComplaints(ours: Record<string, unknown> | undefined, challenge: unknown): string[] {
  const bazaar = (challenge as { extensions?: { bazaar?: { info?: { input?: unknown } } } })
    ?.extensions?.bazaar?.info?.input as
    { body?: Record<string, unknown>; method?: string } | undefined;
  const example = bazaar?.body;
  if (!example || !ours) return [];

  const out: string[] = [];
  for (const key of Object.keys(ours)) {
    if (!(key in example)) out.push(`we send "${key}", which the endpoint's example does not`);
  }
  for (const [key, value] of Object.entries(ours)) {
    const expected = example[key];
    if (expected === undefined) continue;
    const kind = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
    if (kind(value) !== kind(expected)) {
      out.push(`"${key}" is ${kind(value)}, the example has ${kind(expected)}`);
    }
  }
  // Dates are where the formats actually diverge, and the divergence is invisible
  // until it is paid for.
  const walk = (value: unknown, sample: unknown, at: string): void => {
    if (typeof value === "string" && typeof sample === "string") {
      if (ISO_SECONDS.test(sample) && !ISO_SECONDS.test(value)) {
        out.push(`${at} is "${value}", the example uses "${sample}" (no milliseconds)`);
      }
      return;
    }
    if (value && sample && typeof value === "object" && typeof sample === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        walk(
          (value as Record<string, unknown>)[key],
          (sample as Record<string, unknown>)[key],
          `${at}.${key}`,
        );
      }
    }
  };
  walk(ours, example, "body");
  return out;
}

const network = loadConfig().baseNetwork;
const endpoints = await loadCatalog();
let problems = 0;

console.log(
  `Checking ${endpoints.length} catalogue entries against live 402s (network ${network})\n`,
);

for (const endpoint of endpoints) {
  const call = resolveX402Call(endpoint, SAMPLE_SUBJECT);
  const init: RequestInit = { method: call.method, signal: AbortSignal.timeout(25_000) };
  if (call.body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(call.body);
  }

  let line = `${endpoint.id.padEnd(14)} `;
  try {
    const response = await fetch(call.url, init);
    line += `HTTP ${response.status} `;

    if (response.status !== 402) {
      // Anything else means Ward cannot buy from it: 200 would mean it is not
      // actually paid, and 4xx/5xx that it is broken or the body shape is wrong.
      problems++;
      const text = await response.text();
      console.log(`${line}✗ not a payment challenge — ${text.slice(0, 120).replace(/\s+/g, " ")}`);
      continue;
    }

    // The SAME matcher the payment path uses, deliberately — this script existed to
    // catch drift, and a second copy of the offer-matching logic is itself drift. It
    // had one: written against x402 v1 only, it reported Nansen's v2 challenge as
    // "no exact offer on base" when the endpoint was perfectly payable.
    const body: unknown = await response.json();
    const priceUsd = x402QuoteUsd(body, network, USDC[network]!);
    if (priceUsd === null) {
      problems++;
      console.log(`${line}✗ no "exact" USDC offer on ${network} (Ward cannot pay it)`);
      continue;
    }

    const version = (body as { x402Version?: number }).x402Version ?? 1;
    const matches = Math.abs(priceUsd - endpoint.cost_usd) < 1e-9;
    if (!matches) problems++;

    // The body is only validated AFTER payment, so a wrong shape costs real money to
    // discover: the token screener took $0.01 and answered `422 Invalid parameter`
    // because our dates carried milliseconds and Nansen's did not. The 402 carries
    // the endpoint's own example body for free — comparing against it catches that
    // class before anyone pays for it.
    const complaints = bodyComplaints(call.body, body);
    if (complaints.length > 0) problems++;

    console.log(
      `${line}${matches && complaints.length === 0 ? "✓" : "✗"} asks $${priceUsd} ` +
        `(catalogue says $${endpoint.cost_usd}) [x402 v${version}]`,
    );
    for (const complaint of complaints) console.log(`${" ".repeat(15)}↳ body: ${complaint}`);
  } catch (error) {
    problems++;
    console.log(`${line}✗ unreachable — ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(
  problems === 0
    ? "\nEvery entry is live and priced as advertised."
    : `\n${problems} entr${problems === 1 ? "y needs" : "ies need"} attention — a wrong price is quoted to the user at confirmation, and a dead endpoint fails after they say yes.`,
);
process.exit(problems === 0 ? 0 : 1);
