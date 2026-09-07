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

/** A token whose address is valid everywhere, for endpoints that need a subject. */
const SAMPLE_SUBJECT = "0x4200000000000000000000000000000000000006"; // WETH on Base
const USDC: Record<string, string> = {
  base: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "base-sepolia": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

interface Accepts {
  scheme?: string;
  network?: string;
  asset?: string;
  maxAmountRequired?: string;
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

    const body = (await response.json()) as { accepts?: Accepts[] };
    const offer = (body.accepts ?? []).find((a) => a.scheme === "exact" && a.network === network);
    if (!offer) {
      problems++;
      console.log(`${line}✗ no "exact" offer on ${network} (Ward cannot pay it)`);
      continue;
    }

    const priceUsd = Number(offer.maxAmountRequired) / 1e6;
    const isUsdc = offer.asset?.toLowerCase() === USDC[network];
    const matches = Math.abs(priceUsd - endpoint.cost_usd) < 1e-9;
    if (!isUsdc || !matches) problems++;

    console.log(
      `${line}${matches && isUsdc ? "✓" : "✗"} asks $${priceUsd} ` +
        `(catalogue says $${endpoint.cost_usd})${isUsdc ? "" : ` — NOT USDC: ${offer.asset}`}`,
    );
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
