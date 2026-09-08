/**
 * Return USDC stranded in Ward's **ACP agent wallet** to a user's smart account.
 *
 *   bun run scripts/sweep-acp-wallet.ts --telegram 706456243          # dry run
 *   bun run scripts/sweep-acp-wallet.ts --telegram 706456243 --yes
 *
 * The sibling of `sweep-spender.ts`, one hop further along. An ACP job moves the
 * user's money smart account → CDP spender → ACP wallet → escrow, and a failure at
 * the last step leaves it in the ACP wallet — which `sweep-spender.ts` cannot reach,
 * because only the Virtuals adapter can sign for that wallet. Production: $0.50 sat
 * there after `session.fund()` reverted, and the automatic refund could not move it
 * either, for the same reason it had failed in the first place.
 *
 * Needs CDP and the ACP credentials, so from a geoblocked machine run it inside the
 * deployment:
 *   railway ssh "bun run scripts/sweep-acp-wallet.ts --telegram <id> --yes"
 */
import { readWallet } from "../memory/index.ts";
import { VirtualsAcpProvider } from "../src/acp/virtuals.ts";
import { resolveExisting } from "../src/identity/index.ts";
import { loadConfig } from "../src/config.ts";
import { installCdpProxy } from "../src/net.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const live = args.includes("--yes");
const telegram = flag("telegram");
const user = flag("user");

if (!telegram && !user) {
  console.error("usage: --telegram <id> | --user <ward_id>  [--yes]");
  process.exit(1);
}

installCdpProxy();

if (loadConfig().acpMode !== "virtuals") {
  console.error("ACP_MODE is not `virtuals` — there is no ACP wallet to sweep.");
  process.exit(1);
}

const userId = user ?? (await resolveExisting("telegram", telegram!))?.userId;
if (!userId) {
  console.error(`no Ward user for telegram:${telegram}`);
  process.exit(1);
}

const wallet = await readWallet(userId);
if (!wallet) {
  console.error(`${userId} has no wallet record — nothing to return money to.`);
  process.exit(1);
}

console.log(`Ward user:     ${userId}`);
console.log(`Smart account: ${wallet.smart_account}`);

const provider = new VirtualsAcpProvider();

if (!live) {
  // A dry run must not move anything, so it only reports — the balance read lives
  // inside `recoverStranded`, which also sends. Say what would be attempted.
  console.log("\nDRY RUN — nothing moved.");
  console.log("Re-run with --yes to return the ACP wallet's USDC to the smart account.");
  process.exit(0);
}

const { movedUsd, from, to } = await provider.recoverStranded(wallet.account_key);
if (movedUsd <= 0) {
  console.log(`\nACP wallet ${from} holds no USDC — nothing to return.`);
} else {
  console.log(`\nReturned $${movedUsd} from ${from} to ${to}`);
}
process.exit(0);
