import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildGraph } from "../src/agent/graph.ts";
import type { ChannelAdapter, SendMode } from "../src/gateway/adapter.ts";
import { runTurn } from "../src/gateway/core.ts";
import type { Channel } from "../memory/index.ts";
import { resetAcpProvider } from "../src/acp/index.ts";
import { resetWalletProvider, walletProvider } from "../src/wallet/index.ts";
import type { StubWalletProvider } from "../src/wallet/stub.ts";
import { resetBackend } from "../memory/backend.ts";

/** The principal every hermetic test acts as. */
export const USER = "ward_01J9XQ4M7BZK3TVWXY0123456A";
/** The Telegram account that resolves to it — used by the identity tests. */
export const TG_ACCOUNT = "700100200";

let tmpDir = "";

/** Standard hermetic env for a graph test: fs backend, stub providers, no model key. */
export async function hermeticSetup(): Promise<void> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "ward-t7-"));
  process.env.WARD_MEMORY_DIR = tmpDir;
  process.env.SIBYL_MEMORY_MODE = "fs";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  delete process.env.OPENAI_API_KEY;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.ACP_MODE;
  await resetBackend();
  resetWalletProvider();
  resetAcpProvider();
}

export async function hermeticTeardown(): Promise<void> {
  await resetBackend();
  resetWalletProvider();
  resetAcpProvider();
  delete process.env.WARD_MEMORY_DIR;
  delete process.env.SIBYL_MEMORY_MODE;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = "";
}

export type Graph = ReturnType<typeof buildGraph>;

export function newGraph(): Graph {
  return buildGraph();
}

function lastText(messages: unknown[]): string {
  const last = messages.at(-1) as { content?: unknown } | undefined;
  return typeof last?.content === "string" ? last.content : "";
}

/** Send a message; returns the final reply text (or "" if the turn interrupted). */
export async function say(
  graph: Graph,
  thread: string,
  text: string,
  userId = USER,
): Promise<string> {
  const result = await graph.invoke(
    { messages: [new HumanMessage(text)], userId, channel: "telegram", channelAccountId: "" },
    { configurable: { thread_id: thread } },
  );
  return lastText(result.messages);
}

/** Send a message expecting a confirmation interrupt; returns the prompt text. */
export async function askAction(
  graph: Graph,
  thread: string,
  text: string,
  userId = USER,
): Promise<string> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage(text)], userId, channel: "telegram", channelAccountId: "" },
    { configurable: { thread_id: thread } },
  )) as { __interrupt__?: Array<{ value: { text: string } }> };
  const prompt = result.__interrupt__?.[0]?.value.text;
  if (!prompt) throw new Error(`expected a confirmation interrupt, got: ${JSON.stringify(result)}`);
  return prompt;
}

export async function resume(graph: Graph, thread: string, approved: boolean): Promise<string> {
  const result = await graph.invoke(new Command({ resume: { approved } }), {
    configurable: { thread_id: thread },
  });
  return lastText(result.messages);
}

/** Ask + confirm; returns the execution reply. */
export async function confirmAction(graph: Graph, thread: string, text: string): Promise<string> {
  await askAction(graph, thread, text);
  return resume(graph, thread, true);
}

export async function onboard(
  graph: Graph,
  thread: string,
  caps: { risk?: string; perAction?: number; daily?: number } = {},
): Promise<void> {
  await say(graph, thread, "hi");
  await say(graph, thread, caps.risk ?? "moderate");
  await say(graph, thread, String(caps.perAction ?? 50));
  await say(graph, thread, String(caps.daily ?? 100));
}

/** The stub wallet provider's call log — a spend must never appear here after a refusal. */
export function walletCalls(): string[] {
  return (walletProvider() as StubWalletProvider).calls;
}

// --- channel surfaces (Phase 11+) ---

/**
 * A channel that records instead of sending, for driving `runTurn` without a real
 * gateway. `answers` is the queue of confirmation decisions; running out of them
 * stands for "never answered", which the core treats as a refusal.
 */
export class FakeAdapter implements ChannelAdapter {
  /** Every outbound message, with the mode the core asked for. */
  readonly sent: Array<{ text: string; mode: SendMode }> = [];
  readonly confirms: string[] = [];
  typingCalls = 0;

  constructor(
    readonly channel: Channel = "telegram",
    readonly limit = 4096,
    readonly editThrottleMs = 0,
    private answers: Array<boolean | null> = [],
  ) {}

  async typing(): Promise<void> {
    this.typingCalls++;
  }

  async send(text: string, mode: SendMode): Promise<string> {
    this.sent.push({ text, mode });
    return String(this.sent.length - 1);
  }

  async edit(handle: string, text: string, mode: SendMode): Promise<void> {
    this.sent[Number(handle)] = { text, mode };
  }

  async askConfirm(text: string): Promise<boolean | null> {
    this.confirms.push(text);
    return this.answers.shift() ?? null;
  }

  /** Queue how the next confirmations will be answered. */
  willAnswer(...answers: Array<boolean | null>): this {
    this.answers.push(...answers);
    return this;
  }

  /** Everything said since the last `clear()` — what the user would have read. */
  transcript(): string {
    return this.sent.map((m) => m.text).join("\n");
  }

  clear(): this {
    this.sent.length = 0;
    this.confirms.length = 0;
    return this;
  }
}

/** Drive one turn through an adapter and return what the user would have read. */
export async function turnOn(
  graph: Graph,
  adapter: FakeAdapter,
  input: { thread: string; userId: string; accountId: string; text: string },
): Promise<string> {
  adapter.clear();
  await runTurn({
    graph,
    adapter,
    threadId: input.thread,
    userId: input.userId,
    accountId: input.accountId,
    text: input.text,
  });
  return adapter.transcript();
}
