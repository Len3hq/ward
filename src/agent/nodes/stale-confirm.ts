import { AIMessage } from "@langchain/core/messages";

import type { WardStateType } from "../state.ts";

/**
 * A bare "yes" or "no" that answers nothing.
 *
 * Reaching this node means the graph started a FRESH turn with a confirmation-shaped
 * message — so whatever the user was answering is gone: the process restarted, the
 * prompt timed out, or a redeploy took the checkpoint with it. Before this existed
 * the message fell through to the conversational model, which replied "It seems like
 * you might be looking for assistance" to a "Yes" that was meant to approve a swap.
 *
 * The user has to be told two things, in this order: nothing was done, and how to
 * get back to where they were. Anything else — including a friendly non-answer — is
 * worse than useless, because they will believe the spend went through.
 */
export function staleConfirmNode(): Partial<WardStateType> {
  return {
    messages: [
      new AIMessage(
        [
          "I don't have anything waiting for a yes or no, so nothing has been done.",
          "",
          "If you were approving an action, tell me again what you want and I'll put the",
          'confirmation back in front of you — for example: "swap $10 USDC into ETH".',
        ].join("\n"),
      ),
    ],
  };
}
