import { read, readWallet, spentToday } from "../../memory/index.ts";
import { addressUrl } from "../execution/explorer.ts";
import { walletProvider } from "./index.ts";
import type { Hex } from "./provider.ts";

/**
 * "What is my balance?" — one answer, written once.
 *
 * Ward used to have no way to answer this at all: `usdcBalanceUsd` existed on the
 * provider and nothing ever called it, so the model, correctly refusing to guess a
 * number that was not in its context, told users it could not see their wallet.
 * Two callers now share this: the deterministic `balance` intent in
 * `agent/nodes/wallet.ts`, and the `read_wallet_balance` tool the model reaches for
 * when the question arrives in some other shape ("can I afford a $20 swap?").
 *
 * Only the user's OWN smart account is read. The agent spender is shared across
 * every Ward user, so its balance is nobody's to see.
 *
 * Addresses are wrapped in backticks: `gateway/format.ts` turns those into whatever
 * the channel's copyable text is.
 */
export async function balanceReport(userId: string): Promise<string> {
  const [wallet, record, spent] = await Promise.all([
    readWallet(userId),
    read(userId),
    spentToday(userId),
  ]);

  if (wallet === null) {
    return "You don't have a wallet yet — say \"generate my wallet\" and I'll create one on Base.";
  }

  const provider = walletProvider();
  const network = provider.network();
  const address = wallet.smart_account as Hex;
  const explorer = `[View on the explorer](${addressUrl(address, network)})`;

  let balances;
  try {
    balances = await provider.balances(address);
  } catch (error) {
    // A chain read that fails must not be reported as a zero balance — an empty
    // wallet and an unreachable node look identical to the user, and only one of
    // them means "your money isn't there".
    console.error("balance lookup failed:", error);
    return [
      `Your wallet on ${network}:`,
      `\`${wallet.smart_account}\``,
      "I couldn't reach the chain to read its balance just now — try again in a moment.",
      explorer,
    ].join("\n");
  }

  // The address ends its own line on purpose: Discord renders it as a fenced block
  // (see `gateway/format.ts`), and a block mid-sentence reads badly.
  const lines = [
    `Your wallet on ${network}:`,
    `\`${wallet.smart_account}\``,
    `• USDC: $${balances.usdcUsd.toFixed(2)}`,
    `• ETH: ${formatEth(balances.eth)}${balances.eth === 0 ? " — no gas yet" : " (gas)"}`,
  ];

  const permission = wallet.spend_permission;
  lines.push(
    permission === null || permission.status !== "active"
      ? "Spend permission: none active — I can't move anything until you grant one."
      : `Spend permission: active, $${permission.allowance_usd} USDC per ${permission.period_seconds / 86_400} day.`,
  );

  if (record !== null) {
    const cap = record.standing_caps.daily_limit_usd;
    lines.push(
      `Spent today: $${spent.toFixed(2)} of your $${cap} daily cap (remaining $${Math.max(0, cap - spent).toFixed(2)}).`,
    );
  }

  lines.push(explorer);
  return lines.join("\n");
}

/** ETH to a readable precision — gas amounts are small, and `0.0000` reads as zero. */
function formatEth(eth: number): string {
  if (eth === 0) return "0";
  if (eth < 0.000_001) return "<0.000001";
  return String(Number(eth.toFixed(6)));
}
