import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { screenUserInput } from "../guardrails.ts";
import type { WardStateType } from "../state.ts";

/**
 * First node. Resets the per-turn `route`, then hard-blocks explicit prompt
 * injection; everything else passes through to the router. Full detection
 * (suspicious patterns, out-of-scope classifier, `sanitizeUrls`) is wired in
 * Phase 3.
 */
export function guardNode(state: WardStateType): Partial<WardStateType> {
  const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const text = typeof last?.content === "string" ? last.content : "";

  const verdict = screenUserInput(text);
  if (!verdict.ok) {
    return {
      route: "refuse",
      messages: [
        new AIMessage(
          "I can't act on that — it looks like an attempt to override my instructions. " +
            "Ask me something straightforward about your account or a trade.",
        ),
      ],
    };
  }
  return { route: undefined };
}
