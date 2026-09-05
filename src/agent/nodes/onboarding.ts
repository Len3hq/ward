import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { initialize, read } from "../../../memory/index.ts";
import {
  ONBOARDING_ORDER,
  ONBOARDING_QUESTIONS,
  onboardingConfirmation,
  parseRiskLabel,
  parseUsd,
} from "../prompts.ts";
import type { OnboardingDraft, WardStateType } from "../state.ts";

/**
 * Canned-question onboarding — one question per turn (risk label → per-action
 * limit → daily limit). Partial answers live in graph state (`MemorySaver`); only
 * the completed record is written to Sibyl Memory, once, via `store.initialize`.
 *
 * Adapted from Len3's `graph/nodes/onboarding.ts` (one canned question per turn).
 */
export async function onboardingNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const draft: OnboardingDraft = { ...state.onboardingDraft };

  const lastHuman = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const answer = typeof lastHuman?.content === "string" ? lastHuman.content : "";

  // The first still-missing field is the one this message is answering.
  const pending = ONBOARDING_ORDER.find((field) => draft[field] === undefined);

  const patch: OnboardingDraft = {};
  if (pending && answer) {
    if (pending === "risk_label") {
      const value = parseRiskLabel(answer);
      if (value !== undefined) {
        patch.risk_label = value;
        draft.risk_label = value;
      }
    } else {
      const value = parseUsd(answer);
      if (value !== undefined) {
        patch[pending] = value;
        draft[pending] = value;
      }
    }
  }

  const nextMissing = ONBOARDING_ORDER.find((field) => draft[field] === undefined);

  if (nextMissing) {
    // Apologise only if we already asked this exact question and still didn't get it.
    const reask = state.onboardingAsked.includes(nextMissing) && answer.length > 0;
    const text = reask
      ? `Sorry, I didn't catch that. ${ONBOARDING_QUESTIONS[nextMissing]}`
      : ONBOARDING_QUESTIONS[nextMissing];
    return {
      onboardingDraft: patch,
      onboardingAsked: [nextMissing],
      messages: [new AIMessage(text)],
      route: undefined,
    };
  }

  // All three collected — write once.
  const complete = {
    risk_label: draft.risk_label!,
    per_action_limit_usd: draft.per_action_limit_usd!,
    daily_limit_usd: draft.daily_limit_usd!,
  };
  if ((await read(state.userId)) === null) {
    await initialize(state.userId, complete);
  }
  return {
    onboardingDraft: patch,
    messages: [new AIMessage(onboardingConfirmation(complete))],
    route: undefined,
  };
}
