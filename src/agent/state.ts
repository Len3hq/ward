import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

import type { ActionType, Channel, RiskLabel } from "../../memory/index.ts";
import type { ParsedIntent } from "./intent.ts";

/**
 * Graph state. `messages` + `onboarding` are the only per-turn/per-session fields;
 * everything durable lives in Sibyl Memory. The checkpointer (`MemorySaver`) holds
 * this per `thread_id` — a `/newsession` starts a fresh thread, so `messages` and
 * `onboarding` reset while Sibyl Memory persists.
 *
 * Identity arrives as three fields, injected by the gateway. The graph reads and
 * writes memory by `userId` alone; `channel` / `channelAccountId` are carried for
 * audit and for replies that name where the user is, never for authorization.
 * Threads are per-channel (`<channel>:<chat>:<seq>`) while the memory they read is
 * shared — see `MULTI-CHANNEL.md`.
 */

export type Route = "onboarding" | "agent" | "refuse" | "confirm" | "wallet";

/** Answers collected turn-by-turn during onboarding, before `store.initialize`. */
export interface OnboardingDraft {
  risk_label?: RiskLabel;
  per_action_limit_usd?: number;
  daily_limit_usd?: number;
}

/** A spend action the user confirmed — the `execute` node runs the fresh gate then this. */
export interface ConfirmedIntent {
  id: string;
  action_type: ActionType;
  amount_usd: number;
  pair?: string;
  /** send only: the checksum-agnostic 0x address the funds go to. */
  destination?: string;
  endpoint?: { name: string; url: string; method: string; body?: unknown; cost_usd: number };
  acp?: { subject: string };
}

export const WardState = Annotation.Root({
  ...MessagesAnnotation.spec,

  /** The principal (`ward_<ulid>`), resolved by the gateway on every invoke. */
  userId: Annotation<string>(),

  /** Which surface this turn arrived on. */
  channel: Annotation<Channel>({ reducer: (_, next) => next, default: () => "telegram" }),

  /** That channel's own id for the account — the Telegram id, the Discord snowflake. */
  channelAccountId: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),

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

  /** Set by `confirm` on approval, consumed + cleared by `execute`. */
  confirmedIntent: Annotation<ConfirmedIntent | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

export type WardStateType = typeof WardState.State;
