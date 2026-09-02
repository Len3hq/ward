import { read } from "../../../memory/index.ts";
import { SPEND_ACTIONS } from "../intent.ts";
import type { Route, WardStateType } from "../state.ts";

/**
 * Decides the turn's path from Sibyl Memory + the parsed intent:
 *
 *   record exists, intent is a spend action    → confirm
 *   record exists, anything else               → agent
 *   no record, onboarding in progress          → onboarding
 *   no record, intent is any action            → refuse (no authorization → no money moves)
 *   no record, anything else                   → onboarding
 *
 * Adapted from Len3's `graph/nodes/router.ts`. The `no record + action → refuse`
 * branch is what makes the deletion gate structural.
 */
export async function routerNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const record = await read(state.tgId);
  const intent = state.parsedIntent;

  if (record !== null) {
    if (intent && SPEND_ACTIONS.has(intent.action_type))
      return { route: "confirm" satisfies Route };
    return { route: "agent" };
  }

  if (Object.keys(state.onboardingDraft).length > 0) return { route: "onboarding" };

  const isAction = intent !== null && intent.action_type !== "read_only";
  return { route: isAction ? "refuse" : "onboarding" };
}
