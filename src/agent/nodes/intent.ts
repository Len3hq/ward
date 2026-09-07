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

  // Ward asked "which token?" last turn and this is the answer — a bare ticker or
  // address, which in isolation classifies as a question and lands in the chat node.
  const awaiting = state.awaitingSubject;
  if (awaiting) {
    const subject = bareSubject(text);
    if (subject) {
      log("intent", { user: state.userId, action: awaiting.action, source: "subject", ms: 0 });
      return { parsedIntent: { action_type: awaiting.action, token: subject, source: "table" } };
    }
    // They said something else; the question has been dropped.
    return { parsedIntent: await parseIntent(text), awaitingSubject: null };
  }

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

/**
 * A message that is nothing but a token: `0x…` or a bare ticker.
 *
 * Deliberately strict — this reinterprets a message as an ACTION, so anything with
 * a sentence around it goes back through the normal parse.
 */
function bareSubject(text: string): string | undefined {
  const trimmed = text.trim().replace(/^["'`]|["'`]$/g, "");
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return trimmed;
  if (/^\$?[A-Za-z][A-Za-z0-9]{1,9}$/.test(trimmed))
    return trimmed.replace(/^\$/, "").toUpperCase();
  return undefined;
}
