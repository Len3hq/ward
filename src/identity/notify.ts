import type { Channel } from "../../memory/index.ts";

/**
 * Sending an unsolicited message to an account on a channel the current turn did
 * not arrive on.
 *
 * This exists for one job in Phase 10: when a Discord account links, the *Telegram*
 * account has to hear about it. That announcement is the whole phishing backstop —
 * a code extracted by social engineering still surfaces to the real owner, who can
 * `/unlink` — so it has to cross gateways, and the redeeming gateway has no handle
 * on the other one.
 *
 * Each gateway registers itself at startup. Phase 11 folds this into
 * `ChannelAdapter.notify`; until then it is a small registry so the linking code can
 * stay channel-agnostic.
 */

export type Notifier = (accountId: string, text: string) => Promise<void>;

const notifiers = new Map<Channel, Notifier>();

export function registerNotifier(channel: Channel, notifier: Notifier): void {
  notifiers.set(channel, notifier);
}

/** Test hook, and what a gateway calls on shutdown. */
export function clearNotifiers(): void {
  notifiers.clear();
}

export function hasNotifier(channel: Channel): boolean {
  return notifiers.has(channel);
}

/**
 * Best-effort delivery. Returns whether it was actually delivered.
 *
 * A failed announcement must never roll back a link that already succeeded — the
 * link is written, and unwinding it on a transient Telegram error would be worse
 * than a missed message. But it must not pass silently either: the caller tells the
 * redeeming user which accounts could not be reached, so a suspiciously undelivered
 * announcement is visible to somebody.
 */
export async function notifyAccount(
  channel: Channel,
  accountId: string,
  text: string,
): Promise<boolean> {
  const notifier = notifiers.get(channel);
  if (!notifier) return false;
  try {
    await notifier(accountId, text);
    return true;
  } catch (error) {
    console.error(`notify ${channel}:${accountId} failed:`, error);
    return false;
  }
}
