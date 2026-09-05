import type { Channel } from "../../memory/index.ts";

/**
 * What a chat surface has to provide for `runTurn` to drive a conversation on it.
 *
 * The split is deliberate: everything about *Ward* — resolving the principal,
 * streaming the graph, catching the confirmation interrupt, refreshing the episodic
 * summary — lives in `core.ts` and is written once. Everything about a *channel* —
 * how long a message may be, whether markdown needs converting, whether a
 * confirmation is a typed "yes" or a button — lives behind this interface.
 *
 * Channels differ in ways that are not cosmetic, which is why these are methods
 * rather than configuration:
 *
 *   Telegram  4096 chars · markdown must become HTML · confirmations are typed
 *   Discord   2000 chars · markdown is native          · confirmations are buttons
 */

/** Whether the text being sent is a raw fragment or a finished, formattable message. */
export type SendMode = "plain" | "rendered";

export interface ChannelAdapter {
  readonly channel: Channel;

  /** Longest single message this channel accepts, in characters. */
  readonly limit: number;

  /**
   * How often a streaming message may be edited, in ms. `0` disables streaming
   * edits entirely — the turn then sends one finished message.
   */
  readonly editThrottleMs: number;

  /** Best-effort "typing…" indicator. Never throws. */
  typing(): Promise<void>;

  /**
   * Send a message; returns a handle usable with `edit`.
   *
   * `plain` is a partial fragment mid-stream — never formatted, because half a
   * markdown token would break a strict renderer. `rendered` is a finished message
   * the channel may format.
   */
  send(text: string, mode: SendMode): Promise<string>;

  edit(handle: string, text: string, mode: SendMode): Promise<void>;

  /**
   * Put a confirmation to the user and wait for the answer.
   *
   * Resolves `true`/`false` when they decide, or `null` when the question was never
   * answered — a timeout, or the conversation moving on. `null` means *nothing
   * happens*: an unanswered confirmation is a refusal, never an approval.
   *
   * The answer must come from the account that was asked. Telegram gets that for
   * free from the chat; Discord has to check the clicking user explicitly, since a
   * button is visible to anyone who can see the message.
   */
  askConfirm(text: string): Promise<boolean | null>;
}
