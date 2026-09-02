import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { detectSuspicious, screenUserInput } from "../guardrails.ts";
import type { WardStateType } from "../state.ts";

/**
 * First node. Resets the per-turn `route`, hard-blocks explicit prompt injection,
 * and flags (without blocking) suspicious patterns for the agent node to see.
 * Adapted from Len3's guard: `isClearlyUnsafe` → `detectSuspiciousInput` →
 * fast-path allow. Fails open.
 */
export function guardNode(state: WardStateType): Partial<WardStateType> {
  const last = [...state.messages].reverse().find((m) => m instanceof HumanMessage);
  const text = typeof last?.content === "string" ? last.content : "";

  if (!screenUserInput(text).ok) {
    return {
      route: "refuse",
      suspicious: true,
      messages: [
        new AIMessage(
          "I can't act on that — it looks like an attempt to override my instructions. " +
            "Ask me something straightforward about your account or a trade.",
        ),
      ],
    };
  }

  return { route: undefined, suspicious: detectSuspicious(text).suspicious };
}
