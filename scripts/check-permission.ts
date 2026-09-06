/**
 * Read the live Spend Permissions on a smart account, straight from CDP.
 *
 *   bun run scripts/check-permission.ts 0x035Da9a5a6DFcA764633aE19Dc66abfdC57D35a3
 *
 * Takes the ADDRESS the bot printed, so it needs no Sibyl Memory and no account
 * key — which matters because the deployed record lives on Railway's volume, not
 * on this machine. Read-only: it lists permissions and never signs anything.
 *
 * This is the confirmation that actually proves something. `what am I allowed to
 * do?` in chat reports Ward's *memory* of the grant; only this reads the chain.
 */
import { CdpClient } from "@coinbase/cdp-sdk";

import { loadConfig } from "../src/config.ts";
import { installCdpProxy } from "../src/net.ts";

const address = process.argv[2];
if (!address?.startsWith("0x")) {
  console.error("usage: bun run scripts/check-permission.ts <smart_account_address>");
  process.exit(1);
}

const config = loadConfig();
if (!config.cdp) {
  console.error(
    "No CDP credentials in this environment — set CDP_API_KEY_ID/SECRET/WALLET_SECRET.",
  );
  process.exit(1);
}

installCdpProxy(); // Coinbase geoblocks some regions; no-op without CDP_PROXY_URL.

const cdp = new CdpClient({
  apiKeyId: config.cdp.apiKeyId,
  apiKeySecret: config.cdp.apiKeySecret,
  walletSecret: config.cdp.walletSecret,
});

const { spendPermissions } = await cdp.evm.listSpendPermissions({
  address: address as `0x${string}`,
});

if (spendPermissions.length === 0) {
  console.log(`No spend permissions on ${address} — nothing was granted on chain.`);
  process.exit(0);
}

console.log(`${spendPermissions.length} permission(s) on ${address} (${config.baseNetwork}):\n`);
for (const p of spendPermissions) {
  console.log(`  status      ${p.revoked ? "REVOKED" : "ACTIVE"}`);
  console.log(`  spender     ${p.permission.spender}`);
  console.log(`  token       ${p.permission.token}`);
  console.log(`  allowance   $${Number(p.permission.allowance) / 1e6} USDC`);
  console.log(`  period      ${Number(p.permission.period) / 86_400} day(s)`);
  console.log(`  hash        ${p.permissionHash}`);
  console.log(`  created     ${p.createdAt}\n`);
}
