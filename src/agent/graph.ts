import { isAIMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { agentNode } from "./nodes/agent.ts";
import { approvalNode } from "./nodes/approval.ts";
import { confirmNode } from "./nodes/confirm.ts";
import { guardNode } from "./nodes/guard.ts";
import { intentNode } from "./nodes/intent.ts";
import { onboardingNode } from "./nodes/onboarding.ts";
import { refuseNode } from "./nodes/refuse.ts";
import { routerNode } from "./nodes/router.ts";
import { walletNode } from "./nodes/wallet.ts";
import { WardState, type WardStateType } from "./state.ts";
import { APPROVAL_REQUIRED, toolNodeFor } from "./tools.ts";

/**
 * The Ward graph. Topology from Len3's `agent/src/graph/`:
 *
 *   guard → intent → router → (onboarding | agent | refuse | confirm)
 *   confirm → [interrupt: yes/no]
 *   agent ⇄ tools
 *   agent → approval → tools     (when an approval-required tool call is pending)
 *
 * Durable state is Sibyl Memory; the checkpointer only holds per-thread turn
 * state, so it is `MemorySaver` — a `/newsession` is just a new `thread_id`.
 */

async function toolsNode(state: WardStateType): Promise<Partial<WardStateType>> {
  return toolNodeFor(state.tgId).invoke(state) as Promise<Partial<WardStateType>>;
}

function afterGuard(state: WardStateType): "refuse" | "intent" {
  return state.route === "refuse" ? "refuse" : "intent";
}

function afterRouter(
  state: WardStateType,
): "onboarding" | "agent" | "refuse" | "confirm" | "wallet" {
  return state.route ?? "agent";
}

function afterAgent(state: WardStateType): "approval" | "tools" | typeof END {
  const last = state.messages.at(-1);
  if (!last || !isAIMessage(last)) return END;
  const calls = last.tool_calls ?? [];
  if (calls.length === 0) return END;
  return calls.some((call) => APPROVAL_REQUIRED.has(call.name)) ? "approval" : "tools";
}

function afterApproval(state: WardStateType): "tools" | typeof END {
  return state.route === "refuse" ? END : "tools";
}

export function buildGraph(checkpointer: MemorySaver = new MemorySaver()) {
  return new StateGraph(WardState)
    .addNode("guard", guardNode)
    .addNode("intent", intentNode)
    .addNode("router", routerNode)
    .addNode("onboarding", onboardingNode)
    .addNode("agent", agentNode)
    .addNode("refuse", refuseNode)
    .addNode("confirm", confirmNode)
    .addNode("wallet", walletNode)
    .addNode("approval", approvalNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "guard")
    .addConditionalEdges("guard", afterGuard, { refuse: "refuse", intent: "intent" })
    .addEdge("intent", "router")
    .addConditionalEdges("router", afterRouter, {
      onboarding: "onboarding",
      agent: "agent",
      refuse: "refuse",
      confirm: "confirm",
      wallet: "wallet",
    })
    .addEdge("onboarding", END)
    .addEdge("refuse", END)
    .addEdge("confirm", END)
    .addEdge("wallet", END)
    .addConditionalEdges("agent", afterAgent, {
      approval: "approval",
      tools: "tools",
      [END]: END,
    })
    .addConditionalEdges("approval", afterApproval, { tools: "tools", [END]: END })
    .addEdge("tools", "agent")
    .compile({ checkpointer });
}

export type WardGraph = ReturnType<typeof buildGraph>;
