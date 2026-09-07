import { AIMessage, isAIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";

import { APPROVAL_REQUIRED } from "../tools.ts";
import type { WardStateType } from "../state.ts";

/**
 * The HITL payment gate. Adapted verbatim in spirit from Len3's
 * `graph/nodes/approval.ts`: a pending approval-required tool call triggers
 * `interrupt({ type, ... })`; the gateway shows the cost and resumes with
 * `new Command({ resume: { approved } })`. Structural, not prompt-mediated.
 *
 * `APPROVAL_REQUIRED` is empty and this is a pass-through, which is the settled
 * design rather than unfinished work: spending never became a tool call. Phase 5 put
 * it on the deterministic `intent → router → confirm → execute` rail instead, where
 * the cost and the on-chain allowance are read fresh and confirmed by
 * `nodes/confirm.ts`. This node stays because that is one `APPROVAL_REQUIRED.add()`
 * away from being needed again if a tool ever does have to spend.
 */
export function approvalNode(state: WardStateType): Partial<WardStateType> {
  const last = state.messages.at(-1);
  if (!last || !isAIMessage(last)) return {};

  const pending = (last.tool_calls ?? []).filter((call) => APPROVAL_REQUIRED.has(call.name));
  if (pending.length === 0) return {};

  for (const call of pending) {
    const decision = interrupt({
      type: "payment_approval",
      tool: call.name,
      args: call.args,
    }) as { approved: boolean };
    if (!decision.approved) {
      return {
        messages: [new AIMessage(`Cancelled — you declined the ${call.name} approval.`)],
        route: "refuse",
      };
    }
  }
  return {};
}
