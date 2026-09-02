import { HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { readConversation, writeConversation } from "../../memory/index.ts";
import { loadConfig } from "../config.ts";

/**
 * Episodic conversation memory. Adapted from Len3's `memory/session_summary.ts`:
 * a per-user rolling summary, refreshed every few turns, written to Sibyl Memory's
 * HOT state tier (`ward.conversation.<tgId>`). It survives `/newsession` and makes
 * the memory *visibly accumulate* turn over turn — beyond the caps ledger.
 *
 * `maybeSummarize` is fire-and-forget from the gateway after each turn.
 */

const SUMMARIZE_EVERY = 4; // human turns
const MAX_SUMMARY_CHARS = 600;

export async function maybeSummarize(tgId: string, messages: BaseMessage[]): Promise<void> {
  const humanTurns = messages.filter((m) => m instanceof HumanMessage).length;
  if (humanTurns === 0 || humanTurns % SUMMARIZE_EVERY !== 0) return;

  const existing = await readConversation(tgId).catch(() => null);
  if (existing && existing.turn_count >= humanTurns) return; // already covered

  const transcript = messages
    .slice(-2 * SUMMARIZE_EVERY - 2)
    .map((m) => `${m instanceof HumanMessage ? "user" : "ward"}: ${asText(m)}`)
    .filter((line) => line.length > 6)
    .join("\n");

  const summary = await summarize(transcript, existing?.summary);
  if (summary) await writeConversation(tgId, summary.slice(0, MAX_SUMMARY_CHARS), humanTurns);
}

async function summarize(transcript: string, prior?: string): Promise<string> {
  const config = loadConfig();
  if (!config.openaiApiKey) return deterministic(transcript, prior);

  try {
    const { ChatOpenAI } = await import("@langchain/openai");
    const model = new ChatOpenAI({
      model: config.models.guard,
      apiKey: config.openaiApiKey,
      temperature: 0,
      maxTokens: 250,
    });
    const response = await model.invoke([
      {
        role: "system",
        content:
          "Update a 2-4 sentence running summary of this crypto-agent conversation. Keep durable " +
          "facts the agent should remember next session: the user's goals, tokens/positions " +
          "discussed, decisions made, things to follow up. Drop small talk. Return only the summary.",
      },
      {
        role: "user",
        content: `Prior summary: ${prior ?? "(none)"}\n\nRecent turns:\n${transcript}`,
      },
    ]);
    return typeof response.content === "string"
      ? response.content.trim()
      : deterministic(transcript, prior);
  } catch {
    return deterministic(transcript, prior);
  }
}

/** Key-line extraction fallback — no model key. */
function deterministic(transcript: string, prior?: string): string {
  const lines = transcript
    .split("\n")
    .filter((l) => l.startsWith("user:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.length > 3)
    .slice(-4);
  const bullets = lines.map((l) => `– ${l}`).join(" ");
  return [prior, bullets].filter(Boolean).join(" ").trim() || "New conversation.";
}

function asText(message: BaseMessage): string {
  return typeof message.content === "string" ? message.content : "";
}
