import { AIMessage } from "@langchain/core/messages";

import { read } from "../../../memory/index.ts";
import { transfersEnabled } from "../transfers.ts";
import type { WardStateType } from "../state.ts";

/**
 * Terminal node for an action request with no authorization record. The literal
 * behaviour the judges test by deleting the Sibyl Memory entity.
 */
export async function refuseNode(state: WardStateType): Promise<Partial<WardStateType>> {
  // Guard may have already added its own refusal message.
  const last = state.messages.at(-1);
  if (last instanceof AIMessage) return {};

  // Swap / send are recognised but switched off (see `agent/transfers.ts`). Give
  // them a specific, neutral line rather than the generic refusal.
  const action = state.parsedIntent?.action_type;
  if (!transfersEnabled() && (action === "swap" || action === "send")) {
    return {
      messages: [
        new AIMessage(
          "I can't move tokens between wallets that way right now. I can buy on-chain " +
            "data, hire another agent to assess a token, and manage your wallet and limits.",
        ),
      ],
    };
  }

  const hadRecord = (await read(state.userId)) !== null;
  const message = hadRecord
    ? "I can't do that right now."
    : "I have no authorization on file for you in Sibyl Memory, so I won't move any funds — " +
      'not even within what the chain would allow. Say "set me up" and I\'ll take you through ' +
      "onboarding (risk profile, per-action limit, daily limit).";

  return { messages: [new AIMessage(message)] };
}
