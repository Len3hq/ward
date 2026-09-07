/**
 * Return USDC stranded in the shared agent spender to a user's smart account.
 *
 *   bun run scripts/sweep-spender.ts --telegram 706456243              # dry run
 *   bun run scripts/sweep-spender.ts --user ward_… --amount 0.001 --yes
 *
 * The manual counterpart of the automatic unwind in `wallet/cdp.ts`. A purchase
 * pulls USDC into the spender before calling the endpoint, so a failure between
 * those two steps used to leave the user's money in Ward's wallet — which is what
 * happened when the Whale Flows endpoint answered 502: $0.001 pulled, nothing
 * delivered, and a message that claimed nothing had been charged.
 *
 * New failures return the money themselves. This is for what is already stuck.
 *
 * Needs CDP, so from a geoblocked machine run it inside the deployment:
 *   railway ssh "bun run scripts/sweep-spender.ts --user ward_… --amount 0.001 --yes"
 */
import { readWallet } from "../memory/index.ts";
import { resolveExisting } from "../src/identity/index.ts";
import { installCdpProxy } from "../src/net.ts";
import { walletProvider } from "../src/wallet/index.ts";
import type { Hex } from "../src/wallet/provider.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const live = args.includes("--yes");
const telegram = flag("telegram");
const explicitUser = flag("user");
const requested = flag("amount");

installCdpProxy();

const userId = explicitUser ?? (telegram ? await resolveExisting("telegram", telegram) : null);
if (!userId) {
  console.error(
    "usage: bun run scripts/sweep-spender.ts (--user ward_… | --telegram <id>) [--amount <usd>] [--yes]",
  );
  process.exit(1);
}

const wallet = await readWallet(userId);
if (!wallet) {
  console.error(`${userId} has no wallet record — there is nowhere to send it.`);
  process.exit(1);
}

const provider = walletProvider();
const spenderBalance = await provider.balances(wallet.agent_spender as Hex);
const amount = requested === undefined ? spenderBalance.usdcUsd : Number(requested);

console.log(`Ward user:     ${userId}`);
console.log(`Smart account: ${wallet.smart_account}`);
console.log(`Agent spender: ${wallet.agent_spender}`);
console.log(`Spender holds: $${spenderBalance.usdcUsd.toFixed(6)} USDC`);
console.log(`Returning:     $${amount}`);

if (!Number.isFinite(amount) || amount <= 0) {
  console.log("\nNothing to return.");
  process.exit(0);
}
if (amount > spenderBalance.usdcUsd) {
  console.error(
    `\nThe spender only holds $${spenderBalance.usdcUsd.toFixed(6)} — refusing to send more than that.`,
  );
  process.exit(1);
}

if (!live) {
  console.log("\nDry run. Nothing moved. Re-run with --yes to send it back.");
  process.exit(0);
}

// The spender is SHARED. Sweeping everything by default is safe only because the
// float belongs to whoever it was pulled from; pass --amount when in doubt.
const { txHash } = await provider.refundUser(wallet.account_key, amount);
console.log(`\nReturned $${amount} to ${wallet.smart_account}`);
console.log(`tx https://basescan.org/tx/${txHash}`);
