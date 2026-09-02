import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

import type { RiskLabel } from "../../memory/index.ts";
import type { ParsedIntent } from "./intent.ts";

/**
 * Graph state. `messages` + `onboarding` are the only per-turn/per-session fields;
 * everything durable lives in Sibyl Memory. The checkpointer (`MemorySaver`) holds
 * this per `thread_id` — a `/newsession` starts a fresh thread, so `messages` and
 * `onboarding` reset while Sibyl Memory persists.
 */

export type Route = "onboarding" | "agent" | "refuse" | "confirm";

/** Answers collected turn-by-turn during onboarding, before `store.initialize`. */
export interface OnboardingDraft {
  risk_label?: RiskLabel;
  per_action_limit_usd?: number;
  daily_limit_usd?: number;
}

export const WardState = Annotation.Root({
  ...MessagesAnnotation.spec,

  /** Telegram user id, injected by the gateway on every invoke. */
  tgId: Annotation<string>(),

  /** Set by the router, read by its conditional edge. */
  route: Annotation<Route | undefined>(),

  /** Parsed by the `intent` node each turn; `null` during onboarding. */
  parsedIntent: Annotation<ParsedIntent | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /** Guard flagged the turn's input as suspicious (not blocked, just noted). */
  suspicious: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),

  onboardingDraft: Annotation<OnboardingDraft>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),

  /** Onboarding fields already asked at least once — drives the "didn't catch that" re-ask. */
  onboardingAsked: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...prev, ...next])],
    default: () => [],
  }),
});

export type WardStateType = typeof WardState.State;
