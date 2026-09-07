/**
 * Buy one catalogue endpoint for real, through Ward's own spend path.
 *
 *   bun run scripts/x402-buy.ts smart-money --telegram 706456243          # dry run
 *   bun run scripts/x402-buy.ts smart-money --telegram 706456243 --yes    # spends money
 *
 * Deliberately goes through `performSpend`, not straight to the provider: the point
 * is to prove the path a user's "yes" actually takes — fresh gate on the memory caps
 * and the on-chain allowance, the USDC pull inside the Spend Permission, the x402
 * payment, and the ledger write-back. A test that skipped those would prove nothing
 * about the product.
 *
 * Must run where CDP is reachable. Coinbase geoblocks some regions, so from a
 * blocked machine run it inside the deployment instead:
 *
 *   railway ssh "bun run scripts/x402-buy.ts smart-money --telegram <id> --yes"
 */
import { read, readWallet } from "../memory/index.ts";
import { loadConfig } from "../src/config.ts";
import { loadCatalog, resolveX402Call } from "../src/execution/catalog.ts";
import { performSpend } from "../src/execution/perform.ts";
import { resolveExisting } from "../src/identity/index.ts";
import { installCdpProxy } from "../src/net.ts";
import { walletProvider } from "../src/wallet/index.ts";
import type { Hex } from "../src/wallet/provider.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const endpointId = args[0];
const live = args.includes("--yes");
const subject = flag("subject");
const telegram = flag("telegram");
const explicitUser = flag("user");

if (!endpointId || endpointId.startsWith("--")) {
  console.error(
    "usage: bun run scripts/x402-buy.ts <endpoint-id> (--telegram <id> | --user <ward_...>) [--subject <token>] [--yes]",
  );
  process.exit(1);
}

installCdpProxy();
const config = loadConfig();

const endpoint = (await loadCatalog()).find((e) => e.id === endpointId);
if (!endpoint) {
  console.error(`No catalogue entry "${endpointId}".`);
  process.exit(1);
}

const userId = explicitUser ?? (telegram ? await resolveExisting("telegram", telegram) : null);
if (!userId) {
  console.error("Could not resolve a Ward user — pass --user ward_… or --telegram <account id>.");
  process.exit(1);
}

const [record, wallet] = await Promise.all([read(userId), readWallet(userId)]);
if (!record) {
  console.error(`${userId} has no authorization record — nothing can be spent for them.`);
  process.exit(1);
}
if (!wallet) {
  console.error(`${userId} has no wallet record.`);
  process.exit(1);
}

const provider = walletProvider();
const call = resolveX402Call(endpoint, subject);
const maxUsd = Math.round(endpoint.cost_usd * 1.5 * 1e6) / 1e6;

console.log(`Ward user:      ${userId}`);
console.log(`Provider:       ${provider.kind} on ${provider.network()}`);
console.log(`Smart account:  ${wallet.smart_account}`);
console.log(`Agent spender:  ${wallet.agent_spender}`);
console.log(`Endpoint:       ${endpoint.name} (${endpoint.id})`);
console.log(`Request:        ${call.method} ${call.url}`);
if (call.body) console.log(`Body:           ${JSON.stringify(call.body)}`);
console.log(`Catalogue price:$${endpoint.cost_usd}   cap $${maxUsd}`);

const permission = wallet.spend_permission;
console.log(
  `Permission:     ${permission ? `${permission.status}, $${permission.allowance_usd}/period` : "NONE — the spend will refuse"}`,
);

// Read the two balances that decide whether this can work at all: the user's USDC
// (what is pulled) and the spender's ETH (what pays gas for the pull).
try {
  const [user, spender] = await Promise.all([
    provider.balances(wallet.smart_account as Hex),
    provider.balances(wallet.agent_spender as Hex),
  ]);
  console.log(`User USDC:      $${user.usdcUsd.toFixed(6)}   (ETH ${user.eth})`);
  console.log(`Spender:        USDC $${spender.usdcUsd.toFixed(6)}   ETH ${spender.eth} (gas)`);
} catch (error) {
  console.log(`Balances:       unreadable — ${error instanceof Error ? error.message : error}`);
}

if (!live) {
  console.log("\nDry run. Nothing was paid. Re-run with --yes to spend for real.");
  process.exit(0);
}

console.log("\n--- spending, for real ---");
const outcome = await performSpend({
  userId,
  actionType: "x402_data_purchase",
  amountUsd: endpoint.cost_usd,
  idempotencyKey: `x402-buy-${endpoint.id}-${Date.now()}`,
  endpoint: {
    name: endpoint.name,
    url: call.url,
    method: call.method,
    body: call.body,
    cost_usd: endpoint.cost_usd,
  },
});

console.log(outcome.ok ? "OK" : "FAILED");
console.log(outcome.message);
if (outcome.ok) {
  const explorer = config.baseNetwork === "base" ? "basescan.org" : "sepolia.basescan.org";
  console.log(`\nSettlement: https://${explorer}/tx/${outcome.txHash}`);
}
process.exit(outcome.ok ? 0 : 1);
