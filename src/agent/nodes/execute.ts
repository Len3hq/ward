import { AIMessage } from "@langchain/core/messages";

import { performSpend } from "../../execution/perform.ts";
import type { WardStateType } from "../state.ts";

/**
 * Runs a confirmed spend.
 *
 * The sequence itself lives in `execution/perform.ts`, because Phase 16.3 gave MCP a
 * second way to reach it: fresh reads → `evaluateGate` → provider → ledger. Keeping
 * one implementation is the point — this node's job is only to map graph state in and
 * an `AIMessage` out.
 */
export async function executeNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const confirmed = state.confirmedIntent;
  if (!confirmed) return {};

  const outcome = await performSpend({
    userId: state.userId,
    actionType: confirmed.action_type,
    amountUsd: confirmed.amount_usd,
    idempotencyKey: confirmed.id,
    endpoint: confirmed.endpoint,
    pair: confirmed.pair,
    destination: confirmed.destination,
    acpSubject: confirmed.acp?.subject,
  });

  return { confirmedIntent: null, messages: [new AIMessage(outcome.message)] };
}
