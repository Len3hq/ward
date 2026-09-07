import { HumanMessage } from "@langchain/core/messages";

import { read } from "../../../memory/index.ts";
import { log } from "../../log.ts";
import { parseIntent } from "../intent.ts";
import type { WardStateType } from "../state.ts";

/**
 * Parses the turn's message into a structured Ward action (deterministic table
 * first, then one `gpt-4o-mini` call). Skipped while onboarding is still running
 * (draft started AND no record yet) — those answers aren't action requests.
 */
export async function intentNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const draftStarted = Object.keys(state.onboardingDraft).length > 0;
  if (draftStarted && (await read(state.userId)) === null) {
    return { parsedIntent: null };
  }

  const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const text = typeof last?.content === "string" ? last.content : "";
  if (!text.trim()) return { parsedIntent: null };

  const started = performance.now();
  const parsedIntent = await parseIntent(text);
  // `source=llm` is the expensive one: a whole model round trip in front of the
  // agent's own. Logged so its share of a slow turn is visible, not guessed at.
  log("intent", {
    user: state.userId,
    action: parsedIntent.action_type,
    source: parsedIntent.source,
    ms: performance.now() - started,
  });
  return { parsedIntent };
}
