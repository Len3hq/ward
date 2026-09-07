import { createHash } from "node:crypto";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import {
  isRevoked,
  read,
  readWallet,
  spentToday,
  trustScore,
  type ActionType,
} from "../../../memory/index.ts";
import { acpProvider } from "../../acp/index.ts";
import { loadConfig } from "../../config.ts";
import { evaluateGate } from "../../execution/gate.ts";
import {
  endpointNeedsSubject,
  resolveX402Call,
  searchCatalog,
  type ResolvedX402Call,
  type X402Endpoint,
} from "../../execution/catalog.ts";
import { resolveSwapPair } from "../../execution/swap.ts";
import { walletProvider } from "../../wallet/index.ts";
import { describeIntent, tokenDenominatedAmount } from "../intent.ts";
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
  const record = await read(state.userId);
  if (!intent || record === null) {
    return { messages: [new AIMessage("I lost the thread there — say that again?")] };
  }

  const action = intent.action_type as ActionType;
  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const query = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  // --- resolve the concrete action + its cost ---
  let endpoint: X402Endpoint | null = null;
  let resolvedCall: ResolvedX402Call | null = null;
  let acpSubject: string | undefined;
  let destination: string | undefined;
  let acpCounterparty: string | undefined;
  let amountUsd: number;
  /** The normalised `SELL/BUY` for a swap — what `execute` is handed, not the raw parse. */
  let swapPair: string | undefined;

  if (action === "x402_data_purchase") {
    endpoint = await searchCatalog(`${query} ${intent.token ?? ""}`);
    if (!endpoint) {
      return { messages: [new AIMessage(`I don't have an x402 endpoint for that.`)] };
    }
    if (endpointNeedsSubject(endpoint) && !intent.token) {
      return {
        messages: [new AIMessage("Which token? Give me a ticker or a 0x address.")],
      };
    }
    resolvedCall = resolveX402Call(endpoint, intent.token);
    amountUsd = endpoint.cost_usd;
  } else if (action === "acp_job") {
    acpSubject = intent.token ?? intent.pair ?? "the token";
    acpCounterparty = await acpProvider().preferredCounterparty("token_risk");
    amountUsd = intent.amount_usd ?? loadConfig().acpBudgetUsd;
  } else if (action === "send") {
    destination = intent.token;
    if (!destination || !/^0x[a-fA-F0-9]{40}$/.test(destination)) {
      return {
        messages: [new AIMessage("Which address? Give me a 0x address on Base.")],
      };
    }
    amountUsd = intent.amount_usd ?? 0;
    if (amountUsd <= 0) {
      return { messages: [new AIMessage("How much? Give me a USD amount.")] };
    }
  } else {
    // A swap has to be one Ward is authorized to make before its price is discussed:
    // the permission is a USDC allowance, so USDC is the only sellable side.
    if (action === "swap") {
      const resolved = resolveSwapPair(intent.pair);
      if (!resolved.ok) return { messages: [new AIMessage(resolved.message)] };
      swapPair = `${resolved.pair.sell}/${resolved.pair.buy}`;
    }

    // "0.0001 eth" is not $0.0001, and every cap here is in dollars. Read from the
    // user's own words rather than the parsed amount, so an LLM parse that dropped
    // the unit is caught too.
    const denominated = tokenDenominatedAmount(query);
    if (denominated) {
      return {
        messages: [
          new AIMessage(
            [
              `I size every action in USD — your $${record.standing_caps.per_action_limit_usd} per-action limit and`,
              `$${record.standing_caps.daily_limit_usd} daily cap are both in dollars, so I can't check`,
              `${denominated.amount} ${denominated.symbol} against them. Nothing was done.`,
              "",
              `Give me the dollar amount instead — for example "swap $10 USDC into ${denominated.symbol}".`,
            ].join("\n"),
          ),
        ],
      };
    }

    amountUsd = intent.amount_usd ?? 0;
    if (amountUsd <= 0) {
      return { messages: [new AIMessage("How much? Give me a USD amount.")] };
    }
  }

  let summary: string;
  if (action === "x402_data_purchase" && endpoint) {
    summary = `Buy "${endpoint.name}" (~$${endpoint.cost_usd})`;
  } else if (action === "acp_job" && acpCounterparty) {
    const trust = await trustScore(state.userId, acpCounterparty);
    const seen = record.acp_job_history.filter((j) => j.counterparty_id === acpCounterparty).length;
    summary =
      `Hire ${acpCounterparty} (trust ${trust.toFixed(2)}${seen ? `, ${seen} prior job(s)` : ", unproven"}) ` +
      `to assess ${acpSubject} for ~$${amountUsd}`;
  } else if (action === "send" && destination) {
    // Name the destination in full, every time. An address is the one field a user
    // cannot sanity-check from a summary, and it is the one that cannot be undone.
    summary = `Send $${amountUsd} USDC to ${destination}`;
  } else {
    summary = describeIntent(swapPair ? { ...intent, pair: swapPair } : intent);
  }

  // --- gate (for the confirmation copy; execute re-checks on fresh reads) ---
  const spent = await spentToday(state.userId);
  const wallet = await readWallet(state.userId);
  const permission = wallet?.spend_permission ?? null;
  // Addressed by the wallet's pinned key, never the principal — see `nodes/wallet.ts`.
  const accountKey = wallet?.account_key ?? state.userId;

  const provider = walletProvider();
  if (provider.requiresSpendPermission) {
    // Without a permission there is nothing to spend FROM. Saying so here, before a
    // confirmation, is the difference between a clear next step and a "yes" that
    // fails on chain — or worse, one that spends the shared spender's own float.
    if (wallet === null) {
      return {
        messages: [
          new AIMessage(
            "You don't have a wallet yet, so there's nothing to spend from. Say \"generate my wallet\", " +
              "then grant a spend permission, and I can act.",
          ),
        ],
      };
    }
    if (permission === null) {
      return {
        messages: [
          new AIMessage(
            "You haven't granted an on-chain spend permission yet, so I have no authority to move " +
              `your USDC — nothing was done. Say "grant a $${record.standing_caps.daily_limit_usd} daily permission" ` +
              "and I'll set it up, then ask me again.",
          ),
        ],
      };
    }
  }

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
    const live = await provider.readSpendPermission(accountKey).catch(() => null);
    if (live?.status === "revoked") {
      return {
        messages: [
          new AIMessage("Your spend permission was revoked on-chain — grant a new one first."),
        ],
      };
    }
    onchainAllowanceUsd = live?.allowanceUsd ?? permission.allowance_usd;
  }

  const endpointSeen = resolvedCall
    ? record.x402_ledger.some((e) => e.url === resolvedCall!.url)
    : undefined;

  const gate = evaluateGate({
    record,
    actionType: action,
    amountUsd,
    spentTodayUsd: spent,
    revoked: await isRevoked(state.userId, action),
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

  const confirmed = (): ConfirmedIntent => ({
    id: intentId(state, config),
    action_type: action,
    amount_usd: amountUsd,
    pair: swapPair ?? intent.pair,
    destination,
    endpoint:
      endpoint && resolvedCall
        ? {
            name: endpoint.name,
            url: resolvedCall.url,
            method: resolvedCall.method,
            body: resolvedCall.body,
            cost_usd: endpoint.cost_usd,
          }
        : undefined,
    acp: acpSubject ? { subject: acpSubject } : undefined,
  });

  if (!gate.needsApproval) {
    return { confirmedIntent: confirmed() };
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
  return { confirmedIntent: confirmed() };
}

function intentId(state: WardStateType, config: LangGraphRunnableConfig | undefined): string {
  const thread = String(config?.configurable?.thread_id ?? "t");
  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const query = typeof lastHuman?.content === "string" ? lastHuman.content : "";
  return createHash("sha256")
    .update(`${thread}:${state.messages.length}:${query}`)
    .digest("hex")
    .slice(0, 32);
}
