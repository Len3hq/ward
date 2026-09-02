import { AIMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { read, readWallet, spentToday } from "../../../memory/index.ts";
import { loadConfig } from "../../config.ts";
import { BASE_SYSTEM, buildAuthorizationContext } from "../prompts.ts";
import type { WardStateType } from "../state.ts";
import { boundTools } from "../tools.ts";

/**
 * The conversational node. Builds the system prompt from Sibyl Memory (so a fresh
 * session recalls the caps), binds the tools, and calls the model (`gpt-4o-mini`).
 *
 * Without `OPENAI_API_KEY` it falls back to a deterministic recall of the
 * authorization context — enough to demo fresh-session memory recall without a
 * key, and to keep the graph tests hermetic.
 *
 * Adapted from Len3's `graph/nodes/agent.ts` (system prompt = base + profile +
 * context; bind tools; invoke).
 */
export async function agentNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const { tgId } = state;
  const [record, wallet, spent] = await Promise.all([
    read(tgId),
    readWallet(tgId),
    spentToday(tgId),
  ]);

  const context = buildAuthorizationContext(record, wallet, spent);
  const config = loadConfig();

  if (!config.openaiApiKey) {
    return { messages: [new AIMessage(deterministicRecall(context))] };
  }

  const model = new ChatOpenAI({
    model: config.models.agent,
    apiKey: config.openaiApiKey,
    temperature: 0,
    maxTokens: 1024,
  }).bindTools(boundTools(tgId));

  const response = await model.invoke([
    new SystemMessage(`${BASE_SYSTEM}\n\n${context}`),
    ...state.messages,
  ]);

  return { messages: [response] };
}

function deterministicRecall(context: string): string {
  return [
    "(no model key configured — reciting your authorization from Sibyl Memory)",
    "",
    context,
  ].join("\n");
}
