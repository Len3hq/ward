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

/**
 * Where to *find* a channel's bot, for a user who isn't there yet.
 *
 * `/link` mints a code on one app to be redeemed on another, and "go open the other
 * app and find me" was the step people got stuck on. A gateway registers its own
 * deep link once it knows its bot identity — which is why this is separate from
 * `registerChannel`: the id is only available after the client is ready, and the
 * port is registered before login.
 */
const dmLinks = new Map<Channel, string>();

export function registerChannel(channel: Channel, port: ChannelPort): void {
  ports.set(channel, port);
}

/** A URL that opens a DM with this channel's bot. */
export function registerDmLink(channel: Channel, url: string): void {
  dmLinks.set(channel, url);
}

export function dmLink(channel: Channel): string | undefined {
  return dmLinks.get(channel);
}

/**
 * One-click linking, per channel (Phase 15.2/15.3).
 *
 * Both channels can carry a link `state` for the user instead of making them
 * transcribe a code, but by completely different means — Discord through an OAuth2
 * round trip Ward has to serve, Telegram through a `t.me/<bot>?start=<payload>`
 * deep link that needs no server at all. A builder per channel keeps that difference
 * out of the command layer, which only needs to know whether a route exists.
 *
 * Registered by whatever actually knows the URL, once it knows it: the Telegram
 * username after `getMe`, the Discord one when the callback server starts. So an
 * unregistered channel means "not configured here", and `/link` falls back to a
 * code rather than offering a link that goes nowhere.
 */
/**
 * `wallet` is not a channel — it is a credential (Phase 14). It belongs here anyway
 * because from `/link`'s point of view the three are the same shape: a target that
 * can carry a state for the user instead of making them type one.
 */
export type LinkTarget = Channel | "wallet";

const startLinks = new Map<LinkTarget, (state: string) => string>();

export function registerStartLink(target: LinkTarget, build: (state: string) => string): void {
  startLinks.set(target, build);
}

export function startLink(target: LinkTarget, state: string): string | undefined {
  return startLinks.get(target)?.(state);
}

export function hasStartLink(target: LinkTarget): boolean {
  return startLinks.has(target);
}

/** Test hook, and what a gateway calls on shutdown. */
export function clearChannels(): void {
  ports.clear();
  dmLinks.clear();
  startLinks.clear();
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
