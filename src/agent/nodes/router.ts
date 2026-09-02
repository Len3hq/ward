import { HumanMessage } from "@langchain/core/messages";

import { read } from "../../../memory/index.ts";
import { looksLikeActionRequest } from "../guardrails.ts";
import type { Route, WardStateType } from "../state.ts";

/**
 * Decides the turn's path from Sibyl Memory + the message:
 *
 *   record exists                        → agent
 *   no record, onboarding in progress    → onboarding
 *   no record, message is an action      → refuse (no authorization → no money moves)
 *   no record, anything else             → onboarding (start the questions)
 *
 * Adapted from Len3's `graph/nodes/router.ts` (profile fetch → onboarding vs.
 * agent). The `no record + action → refuse` branch is what makes the deletion
 * gate structural: remove the Sibyl Memory entity and every action request lands
 * on `refuse`.
 */
export async function routerNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const record = await read(state.tgId);
  if (record !== null) return { route: "agent" satisfies Route };

  const onboardingInProgress = Object.keys(state.onboardingDraft).length > 0;
  if (onboardingInProgress) return { route: "onboarding" };

  const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const text = typeof last?.content === "string" ? last.content : "";
  return { route: looksLikeActionRequest(text) ? "refuse" : "onboarding" };
}
