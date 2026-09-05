import type { Channel } from "../../memory/index.ts";
import type { ChannelAdapter } from "./adapter.ts";

/**
 * The live gateways, so code that isn't holding one can still reach a user.
 *
 * Two things need this, and neither has a `ctx` to work from:
 *
 * - **Link announcements.** When a Discord account links, the *Telegram* account has
 *   to hear about it. That announcement is the phishing backstop, and the redeeming
 *   gateway has no handle on the other one.
 * - **Proposal delivery.** A proposal made over MCP is replayed as a real turn on a
 *   human channel, which needs a full `ChannelAdapter` built for a user who is not
 *   currently talking to us.
 *
 * Each gateway registers itself at startup. This is in-process only: the MCP server
 * runs as its own process and registers nothing, which is exactly why it queues
 * proposals through Sibyl Memory rather than delivering them itself.
 */

export interface ChannelPort {
  /** Send one unsolicited message. */
  notify(accountId: string, text: string): Promise<void>;
  /**
   * Build an adapter for an arbitrary account, so a turn can be pushed to someone
   * who did not just message us. `null` when the account can't be reached.
   */
  adapterFor(accountId: string): Promise<ChannelAdapter | null>;
}

const ports = new Map<Channel, ChannelPort>();

export function registerChannel(channel: Channel, port: ChannelPort): void {
  ports.set(channel, port);
}

/** Test hook, and what a gateway calls on shutdown. */
export function clearChannels(): void {
  ports.clear();
}

export function hasChannel(channel: Channel): boolean {
  return ports.has(channel);
}

export function registeredChannels(): Channel[] {
  return [...ports.keys()];
}

/**
 * Best-effort delivery. Returns whether it actually went.
 *
 * A failed announcement must never roll back a link that already succeeded —
 * unwinding it on a transient network error would be worse than a missed message.
 * But it must not pass silently either: callers report what could not be reached, so
 * a suspiciously undelivered announcement is visible to somebody.
 */
export async function notifyAccount(
  channel: Channel,
  accountId: string,
  text: string,
): Promise<boolean> {
  const port = ports.get(channel);
  if (!port) return false;
  try {
    await port.notify(accountId, text);
    return true;
  } catch (error) {
    console.error(`notify ${channel}:${accountId} failed:`, error);
    return false;
  }
}

export async function adapterFor(
  channel: Channel,
  accountId: string,
): Promise<ChannelAdapter | null> {
  const port = ports.get(channel);
  if (!port) return null;
  try {
    return await port.adapterFor(accountId);
  } catch (error) {
    console.error(`adapterFor ${channel}:${accountId} failed:`, error);
    return null;
  }
}
