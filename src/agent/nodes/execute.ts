import { AIMessage } from "@langchain/core/messages";

import {
  appendSpend,
  appendX402,
  isRevoked,
  read,
  readWallet,
  spentToday,
} from "../../../memory/index.ts";
import { loadConfig } from "../../config.ts";
import { txUrl } from "../../execution/explorer.ts";
import { evaluateGate } from "../../execution/gate.ts";
import { walletProvider } from "../../wallet/index.ts";
import type { WardStateType } from "../state.ts";

/**
 * Runs a confirmed spend. Order of operations (ported from Len3's
 * `X402Service.request_premium_data` reserve→check→refresh→deduct):
 *
 * 1. FRESH `read` / `spentToday` / `isRevoked` / on-chain allowance
 * 2. `evaluateGate` — a revocation between confirmation and here still blocks
 * 3. execute on Base via the wallet provider
 * 4. `appendSpend` (idempotent on `confirmedIntent.id`) + trust write-back
 * 5. reply with the tx hash + explorer link
 */
export async function executeNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const confirmed = state.confirmedIntent;
  if (!confirmed) return {};

  const clear: Partial<WardStateType> = { confirmedIntent: null };
  const record = await read(state.tgId);
  if (record === null) {
    return { ...clear, messages: [new AIMessage("Your authorization is gone — I won't act.")] };
  }

  const spent = await spentToday(state.tgId);
  const wallet = await readWallet(state.tgId);
  const permission = wallet?.spend_permission ?? null;

  let onchainAllowanceUsd: number | null = null;
  if (permission) {
    if (permission.status !== "active") {
      return { ...clear, messages: [new AIMessage("Spend permission revoked — nothing moved.")] };
    }
    const live = await walletProvider()
      .readSpendPermission(state.tgId)
      .catch(() => null);
    if (live?.status === "revoked") {
      return {
        ...clear,
        messages: [new AIMessage("Spend permission revoked on-chain — nothing moved.")],
      };
    }
    onchainAllowanceUsd = live?.allowanceUsd ?? permission.allowance_usd;
  }

  const gate = evaluateGate({
    record,
    actionType: confirmed.action_type,
    amountUsd: confirmed.amount_usd,
    spentTodayUsd: spent,
    revoked: await isRevoked(state.tgId, confirmed.action_type),
    onchainAllowanceUsd,
    endpointSeen: confirmed.endpoint
      ? record.x402_ledger.some((e) => e.url === confirmed.endpoint!.url)
      : undefined,
  });
  if (!gate.allow) {
    return {
      ...clear,
      messages: [new AIMessage(`Blocked at execution — ${gate.reason} Nothing moved.`)],
    };
  }

  const provider = walletProvider();
  const network = loadConfig().baseNetwork;

  try {
    if (confirmed.action_type === "x402_data_purchase" && confirmed.endpoint) {
      const endpoint = confirmed.endpoint;
      const result = await provider.payX402(state.tgId, {
        url: endpoint.url,
        method: endpoint.method,
        expectedUsd: endpoint.cost_usd,
        maxUsd: round2(endpoint.cost_usd * 1.5),
      });
      await appendSpend(state.tgId, {
        action_type: "x402_data_purchase",
        amount_usd: result.amountUsd,
        tx_hash: result.txHash,
        idempotency_key: confirmed.id,
      });
      await appendX402(state.tgId, { url: endpoint.url, ok: true, amount_usd: result.amountUsd });
      return {
        ...clear,
        messages: [
          new AIMessage(
            `Paid $${result.amountUsd} for "${endpoint.name}". ${txUrl(result.txHash, network)}\n\n${preview(result.data)}`,
          ),
        ],
      };
    }

    if (confirmed.action_type === "swap") {
      const [sell = "USDC", buy = "ETH"] = (confirmed.pair ?? "USDC/ETH").split("/");
      const result = await provider.swap(state.tgId, {
        sellSymbol: sell,
        buySymbol: buy,
        amountUsd: confirmed.amount_usd,
      });
      await appendSpend(state.tgId, {
        action_type: "swap",
        amount_usd: result.sellUsd,
        tx_hash: result.txHash,
        idempotency_key: confirmed.id,
      });
      return {
        ...clear,
        messages: [
          new AIMessage(
            `Swapped $${result.sellUsd} ${sell.toUpperCase()} → ${buy.toUpperCase()} (${result.buyDisplay}). ${txUrl(result.txHash, network)}`,
          ),
        ],
      };
    }

    return { ...clear, messages: [new AIMessage("ACP jobs land in the next build phase.")] };
  } catch (error) {
    if (confirmed.endpoint) {
      await appendX402(state.tgId, {
        url: confirmed.endpoint.url,
        ok: false,
        amount_usd: 0,
      }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...clear,
      messages: [new AIMessage(`Execution failed: ${message}. Nothing was charged beyond gas.`)],
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function preview(data: unknown): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
