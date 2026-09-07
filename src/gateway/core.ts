import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import type { WardGraph } from "../agent/graph.ts";
import { maybeSummarize } from "../agent/summary.ts";
import { log, logError, preview } from "../log.ts";
import type { ChannelAdapter } from "./adapter.ts";

/**
 * One conversational turn, on any channel.
 *
 * This is the whole of Ward's gateway behaviour — graph streaming with throttled
 * edits, the confirmation interrupt, the episodic-summary refresh — with every
 * channel-specific decision pushed behind `ChannelAdapter`. Adding a surface means
 * writing an adapter, not another copy of this.
 *
 * Adapted from Len3's `gateways/telegram.ts`, which had all of it inline.
 */

/** A confirmation loop that never settles is a bug; this bounds it. */
const MAX_CONFIRMATIONS = 4;

/**
 * How often the "typing…" indicator is refreshed while a turn is working.
 *
 * Telegram's lasts about five seconds and Discord's about ten, so sending it once
 * at the start — which is all Ward used to do — leaves the chat looking idle for
 * most of a turn that takes a few seconds. Two model round trips and a chain read
 * is a normal turn, and silence during it reads as "the bot is broken".
 */
const TYPING_INTERVAL_MS = 4_000;

export interface TurnInput {
  graph: WardGraph;
  adapter: ChannelAdapter;
  /** Per-channel conversation thread, e.g. `telegram:123:1`. */
  threadId: string;
  /** The principal, already resolved by the gateway. */
  userId: string;
  /** The channel's own id for the account, carried into state for audit. */
  accountId: string;
  text: string;
}

export async function runTurn(input: TurnInput): Promise<void> {
  const { graph, adapter, threadId, userId, accountId, text } = input;
  const config = { configurable: { thread_id: threadId } };
  const started = performance.now();
  const context = { channel: adapter.channel, account: accountId, user: userId, thread: threadId };

  log("turn.start", { ...context, chars: text.length, text: preview(text) });

  // Fire-and-forget: a Telegram API round trip must not sit in front of the graph.
  const typing = new TypingIndicator(adapter);
  typing.start();

  const session = new OutboundMessage(adapter);
  let next: Parameters<WardGraph["stream"]>[0] = {
    messages: [new HumanMessage(text)],
    userId,
    channel: adapter.channel,
    channelAccountId: accountId,
  };

  try {
    for (let round = 0; round < MAX_CONFIRMATIONS; round++) {
      const graphStarted = performance.now();
      const result = await streamOnce(graph, config, next, session);
      log("turn.graph", { ...context, round, ms: performance.now() - graphStarted });

      if (result.interruptText === undefined) {
        const reply = result.finalText || "(no response)";
        await session.finish(reply);
        log("turn.done", {
          ...context,
          ms: performance.now() - started,
          chars: reply.length,
          text: preview(reply),
        });
        break;
      }

      // The turn pauses here — possibly for minutes — while the user decides. The
      // typing indicator has to stop, or Ward appears to type for ten minutes.
      typing.stop();
      log("confirm.ask", { ...context, text: preview(result.interruptText) });
      const waited = performance.now();
      const approved = await adapter.askConfirm(result.interruptText);
      log("confirm.answer", {
        ...context,
        answer: approved === null ? "none" : approved ? "yes" : "no",
        ms: performance.now() - waited,
      });

      if (approved === null) {
        // Unanswered is not approved. Nothing moves, and we say so rather than
        // leaving a silent pending action the user might assume went through.
        await session.finish("I didn't get an answer, so I didn't do anything.");
        log("turn.done", { ...context, ms: performance.now() - started, answer: "none" });
        break;
      }
      typing.start();
      session.reset();
      next = new Command({ resume: { approved } });
    }
  } catch (error) {
    logError("turn.failed", error, { ...context, ms: performance.now() - started });
    await adapter.send("Something went wrong on my side. Try again in a moment.", "rendered");
    return;
  } finally {
    typing.stop();
  }

  await refreshSummary(graph, config, userId);
}

/**
 * Keeps "typing…" alive for as long as the turn is actually working, and — just as
 * importantly — stops it while a confirmation is open, because a chat that types
 * for ten minutes is worse than one that says nothing.
 */
export class TypingIndicator {
  #adapter: ChannelAdapter;
  #intervalMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(adapter: ChannelAdapter, intervalMs = TYPING_INTERVAL_MS) {
    this.#adapter = adapter;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer) return;
    void this.#adapter.typing();
    this.#timer = setInterval(() => void this.#adapter.typing(), this.#intervalMs);
    // Never hold the process open on a typing indicator.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

interface StreamResult {
  finalText: string;
  /** Present when the graph paused for a confirmation. */
  interruptText: string | undefined;
}

async function streamOnce(
  graph: WardGraph,
  config: { configurable: { thread_id: string } },
  input: Parameters<WardGraph["stream"]>[0],
  session: OutboundMessage,
): Promise<StreamResult> {
  let finalText = "";
  let interruptText: string | undefined;

  const stream = await graph.stream(input, { ...config, streamMode: ["messages", "values"] });
  for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
    if (mode === "messages") {
      const piece = messageChunkText(chunk);
      if (piece) await session.append(piece);
    } else if (mode === "values") {
      const value = chunk as {
        __interrupt__?: Array<{ value?: { text?: string } }>;
        messages?: unknown[];
      };
      const pending = value.__interrupt__?.[0]?.value;
      if (pending) {
        interruptText = pending.text ?? "Confirm? (yes / no)";
      } else {
        const last = lastAiText(value.messages ?? []);
        if (last) finalText = last;
      }
    }
  }

  return { finalText: finalText || session.buffered(), interruptText };
}

/**
 * The message being streamed into. Holds the partial text and the channel handle so
 * a turn edits one message rather than posting a dozen fragments.
 */
class OutboundMessage {
  #adapter: ChannelAdapter;
  #handle: string | undefined;
  #buffer = "";
  #lastEdit = 0;

  constructor(adapter: ChannelAdapter) {
    this.#adapter = adapter;
  }

  buffered(): string {
    return this.#buffer;
  }

  /** Drop the streamed text but keep the handle, so a resume edits the same message. */
  reset(): void {
    this.#buffer = "";
  }

  async append(piece: string): Promise<void> {
    this.#buffer += piece;
    const throttle = this.#adapter.editThrottleMs;
    if (throttle === 0 || Date.now() - this.#lastEdit <= throttle) return;
    this.#lastEdit = Date.now();
    await this.#write(this.#buffer.slice(0, this.#adapter.limit), "plain");
  }

  /** Send the finished text, split across the channel's message limit. */
  async finish(text: string): Promise<void> {
    const chunks = splitMessage(text, this.#adapter.limit);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) await this.#write(chunks[i]!, "rendered");
      else await this.#adapter.send(chunks[i]!, "rendered");
    }
  }

  /** Edit the streamed message if there is one, otherwise start it. */
  async #write(text: string, mode: "plain" | "rendered"): Promise<void> {
    if (this.#handle === undefined) {
      this.#handle = await this.#adapter.send(text, mode);
      return;
    }
    await this.#adapter.edit(this.#handle, text, mode);
  }
}

/** Fire-and-forget episodic-memory refresh after a turn (Sibyl Memory HOT state). */
async function refreshSummary(
  graph: WardGraph,
  config: { configurable: { thread_id: string } },
  userId: string,
): Promise<void> {
  try {
    const snapshot = await graph.getState(config);
    const messages = (snapshot.values as { messages?: BaseMessage[] }).messages ?? [];
    await maybeSummarize(userId, messages);
  } catch (error) {
    logError("summary.failed", error, { user: userId });
  }
}

// --- shared rendering helpers ---

function messageChunkText(chunk: unknown): string {
  const first = Array.isArray(chunk) ? chunk[0] : chunk;
  const content = (first as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : "";
}

function lastAiText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message instanceof AIMessage &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      return message.content;
    }
  }
  return "";
}

/**
 * Break text to fit a channel's message limit, preferring a newline, then a space,
 * then a hard cut. Channel-independent: only the limit differs.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) out.push(rest);
  return out;
}
