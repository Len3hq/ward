import { createHash } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { isRevoked, read, readWallet, spentToday, type ActionType } from "../../../memory/index.ts";
import { evaluateGate } from "../../execution/gate.ts";
import { searchCatalog, type X402Endpoint } from "../../execution/catalog.ts";
import { walletProvider } from "../../wallet/index.ts";
import { describeIntent } from "../intent.ts";
import type { ConfirmedIntent, WardStateType } from "../state.ts";

/**
 * Confirm-before-execute. Resolves the concrete action (an x402 endpoint from the
 * catalog, a swap pair), runs the authorization gate for the confirmation copy,
 * and `interrupt()`s for a plain yes/no. On "yes" it hands a `confirmedIntent` to
 * the `execute` node, which re-runs the gate on fresh reads before spending.
 */
export async function confirmNode(
  state: WardStateType,
  config?: LangGraphRunnableConfig,
): Promise<Partial<WardStateType>> {
  const intent = state.parsedIntent;
  const record = await read(state.tgId);
  if (!intent || record === null) {
    return { messages: [new AIMessage("I lost the thread there — say that again?")] };
  }

  const action = intent.action_type as ActionType;
  if (action === "acp_job") {
    return {
      messages: [new AIMessage("Hiring an agent to assess a token lands in the next build phase.")],
    };
  }

  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const query = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  // --- resolve the concrete action + its cost ---
  let endpoint: X402Endpoint | null = null;
  let amountUsd: number;
  if (action === "x402_data_purchase") {
    endpoint = await searchCatalog(`${query} ${intent.token ?? ""}`);
    if (!endpoint) {
      return { messages: [new AIMessage(`I don't have an x402 endpoint for that.`)] };
    }
    amountUsd = endpoint.cost_usd;
  } else {
    amountUsd = intent.amount_usd ?? 0;
    if (amountUsd <= 0) {
      return { messages: [new AIMessage("How much? Give me a USD amount.")] };
    }
  }

  const summary =
    action === "x402_data_purchase" && endpoint
      ? `Buy "${endpoint.name}" (~$${endpoint.cost_usd})`
      : describeIntent(intent);

  // --- gate (for the confirmation copy; execute re-checks on fresh reads) ---
  const spent = await spentToday(state.tgId);
  const wallet = await readWallet(state.tgId);
  const permission = wallet?.spend_permission ?? null;

  if (permission && permission.status !== "active") {
    return {
      messages: [
        new AIMessage(
          "Your on-chain spend permission is revoked — grant a new one before I can move funds.",
        ),
      ],
    };
  }

  let onchainAllowanceUsd: number | null = null;
  if (permission) {
    const live = await walletProvider()
      .readSpendPermission(state.tgId)
      .catch(() => null);
    if (live?.status === "revoked") {
      return {
        messages: [
          new AIMessage("Your spend permission was revoked on-chain — grant a new one first."),
        ],
      };
    }
    onchainAllowanceUsd = live?.allowanceUsd ?? permission.allowance_usd;
  }

  const endpointSeen = endpoint
    ? record.x402_ledger.some((e) => e.url === endpoint!.url)
    : undefined;

  const gate = evaluateGate({
    record,
    actionType: action,
    amountUsd,
    spentTodayUsd: spent,
    revoked: await isRevoked(state.tgId, action),
    onchainAllowanceUsd,
    endpointSeen,
  });

  if (!gate.allow) {
    return { messages: [new AIMessage(`Can't do that — ${gate.reason}`)] };
  }

  const memRemaining = Math.max(0, record.standing_caps.daily_limit_usd - spent);
  const onchainLine =
    onchainAllowanceUsd === null
      ? "no on-chain permission — memory caps only"
      : `on-chain allowance $${Math.max(0, onchainAllowanceUsd - spent).toFixed(2)} remaining`;
  const prompt = `${summary}. $${spent.toFixed(2)} of your $${record.standing_caps.daily_limit_usd} daily cap used, $${memRemaining.toFixed(2)} left; ${onchainLine}. Confirm? (yes / no)`;

  if (!gate.needsApproval) {
    return {
      confirmedIntent: buildConfirmed(state, config, action, amountUsd, intent.pair, endpoint),
    };
  }

  const decision = interrupt({
    type: "confirm_action",
    action,
    summary,
    amount_usd: amountUsd,
    executable_usd: gate.executableUsd,
    text: prompt,
  }) as { approved: boolean };

  if (!decision.approved) {
    return { messages: [new AIMessage("Cancelled — nothing moved.")] };
  }
  return {
    confirmedIntent: buildConfirmed(state, config, action, amountUsd, intent.pair, endpoint),
  };
}

function buildConfirmed(
  state: WardStateType,
  config: LangGraphRunnableConfig | undefined,
  action: ActionType,
  amountUsd: number,
  pair: string | undefined,
  endpoint: X402Endpoint | null,
): ConfirmedIntent {
  const thread = String(config?.configurable?.thread_id ?? "t");
  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const query = typeof lastHuman?.content === "string" ? lastHuman.content : "";
  const id = createHash("sha256")
    .update(`${thread}:${state.messages.length}:${query}`)
    .digest("hex")
    .slice(0, 32);

  return {
    id,
    action_type: action,
    amount_usd: amountUsd,
    pair,
    endpoint: endpoint
      ? {
          name: endpoint.name,
          url: endpoint.url,
          method: endpoint.method,
          cost_usd: endpoint.cost_usd,
        }
      : undefined,
  };
}
