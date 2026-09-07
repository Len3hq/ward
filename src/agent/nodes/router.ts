import { HumanMessage } from "@langchain/core/messages";

import { read } from "../../../memory/index.ts";
import { isBareAnswer } from "../../gateway/answers.ts";
import { SPEND_ACTIONS, type IntentAction } from "../intent.ts";
import type { Route, WardStateType } from "../state.ts";

const WALLET_ACTIONS: ReadonlySet<IntentAction> = new Set<IntentAction>([
  "generate_wallet",
  "grant_permission",
  "revoke",
  "balance",
]);

/**
 * Decides the turn's path from Sibyl Memory + the parsed intent:
 *
 *   record exists, a bare "yes"/"no"           → stale_confirm (nothing is pending)
 *   record exists, intent is a spend action    → confirm
 *   record exists, intent is a wallet action   → wallet  (incl. reading the balance)
 *   record exists, anything else               → agent
 *   no record, onboarding in progress          → onboarding
 *   no record, intent is any action            → refuse (no authorization → no money moves)
 *   no record, anything else                   → onboarding
 *
 * Adapted from Len3's `graph/nodes/router.ts`. The `no record + action → refuse`
 * branch is what makes the deletion gate structural.
 */
export async function routerNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const record = await read(state.userId);
  const intent = state.parsedIntent;

  if (record !== null) {
    // A confirmation is answered by RESUMING the interrupt, which re-enters the graph
    // at `confirm` and never reaches here. So a bare yes/no arriving as a fresh turn
    // is answering something that no longer exists — say so, rather than letting the
    // model improvise a reply to it.
    if (isBareAnswer(lastHumanText(state))) return { route: "stale_confirm" satisfies Route };

    // A choice from the list `confirm` just offered. "2" parses as nothing at all, so
    // without this it reaches the conversational node — which cannot buy anything and
    // would improvise a reply to a selection the user believes they just made.
    if (state.x402Choices && isChoiceReply(lastHumanText(state))) {
      return { route: "confirm" satisfies Route };
    }

    if (intent && SPEND_ACTIONS.has(intent.action_type)) {
      return { route: "confirm" satisfies Route };
    }
    if (intent && WALLET_ACTIONS.has(intent.action_type)) {
      return { route: "wallet" };
    }
    return { route: "agent" };
  }

  if (Object.keys(state.onboardingDraft).length > 0) return { route: "onboarding" };

  const isAction = intent !== null && intent.action_type !== "read_only";
  return { route: isAction ? "refuse" : "onboarding" };
}

/**
 * Could this be picking from an offered list? Deliberately loose — `confirm` does the
 * real resolution and falls back to a fresh search when it cannot match, so a false
 * positive costs nothing. A short reply is the giveaway: a number, or a few words
 * naming one of the options.
 */
function isChoiceReply(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= 60 && /^(?:option\s*|no\.?\s*|#)?\d{1,2}\b|[a-z]/i.test(t);
}

function lastHumanText(state: WardStateType): string {
  const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  return typeof last?.content === "string" ? last.content : "";
}
