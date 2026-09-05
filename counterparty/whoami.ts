import { base } from "@account-kit/infra";
import { AcpAgent, PrivyAlchemyEvmProviderAdapter } from "@virtuals-protocol/acp-node-v2";

/**
 * Pre-flight for the ACP spike. Answers the two questions you can't answer by
 * squinting at the console:
 *
 *   1. What is registered against these credentials — and does it have an
 *      offering? No offering means no job: `createJobByOfferingName` has nothing
 *      to name, and the price is what escrow funds.
 *   2. Does `browseAgents("token risk")` actually return it? That is the exact
 *      call Ward's `preferredCounterparty()` makes. If this agent is not in the
 *      list, Ward cannot hire it, whatever the console shows.
 *
 *   bun run counterparty/whoami.ts
 */

const KEYWORD = "token risk";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`set ${name} in counterparty/.env`);
  return value;
}

const agent = await AcpAgent.create({
  evmProvider: await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: required("ACP_WALLET_ADDRESS") as `0x${string}`,
    walletId: required("ACP_WALLET_ID"),
    signerPrivateKey: required("ACP_SIGNER_KEY"),
    chains: [base],
  }),
});

const me = await agent.getMe();
console.log(`\n=== this agent ===`);
console.log(`name     ${me.name}`);
console.log(`wallet   ${me.walletAddress}`);
console.log(`hidden   ${me.isHidden}`);

if (me.offerings.length === 0) {
  console.log(`\n!! NO OFFERINGS — Ward cannot hire this agent.`);
  console.log(`   Add one on the agent's ACP tab, priced at or below Ward's`);
  console.log(`   WARD_ACP_BUDGET_USD, with "${KEYWORD}" in the name/description.`);
} else {
  console.log(`\n=== offerings ===`);
  for (const o of me.offerings) {
    console.log(`- "${o.name}" — ${o.priceValue} (${o.priceType})`);
    console.log(`  ${o.description}`);
    console.log(`  requirements: ${JSON.stringify(o.requirements)}`);
    console.log(`  hidden: ${o.isHidden}  private: ${o.isPrivate}`);
  }
}

console.log(`\n=== browseAgents("${KEYWORD}") — what Ward will find ===`);
const found = await agent.browseAgents(KEYWORD, { topK: 5 });
if (found.length === 0) {
  console.log(`nothing. Ward's preferredCounterparty() would fail here.`);
} else {
  for (const a of found) {
    const mine = a.walletAddress.toLowerCase() === me.walletAddress.toLowerCase();
    console.log(`- ${a.name} ${a.walletAddress}${mine ? "   <-- THIS AGENT" : ""}`);
    console.log(
      `  offerings: ${a.offerings.map((o) => `"${o.name}" @ ${o.priceValue}`).join(", ")}`,
    );
  }
  if (!found.some((a) => a.walletAddress.toLowerCase() === me.walletAddress.toLowerCase())) {
    console.log(`\n!! This agent is NOT in the results — Ward would hire someone else,`);
    console.log(`   or fail. Check the offering's keywords and that it is not hidden.`);
  }
}

await agent.stop();
