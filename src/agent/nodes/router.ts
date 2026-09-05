import { read } from "../../../memory/index.ts";
import { SPEND_ACTIONS, type IntentAction } from "../intent.ts";
import type { Route, WardStateType } from "../state.ts";

const WALLET_ACTIONS: ReadonlySet<IntentAction> = new Set<IntentAction>([
  "connect_wallet",
  "grant_permission",
  "revoke",
]);

/**
 * Decides the turn's path from Sibyl Memory + the parsed intent:
 *
 *   record exists, intent is a spend action    → confirm
 *   record exists, intent is a wallet action   → wallet
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
