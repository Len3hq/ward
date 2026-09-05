import {
  appendJournalEvent,
  read,
  readProposalQueue,
  writeProposalQueue,
  type Channel,
  type Proposal,
} from "../../memory/index.ts";
import type { WardGraph } from "../agent/graph.ts";
import { accountsFor } from "../identity/index.ts";
import { adapterFor, registeredChannels } from "./channels.ts";
import { runTurn } from "./core.ts";

/**
 * Delivers proposals made over MCP to a human channel.
 *
 * The MCP server is a separate process — stdio, spawned by whatever client is using
 * it — so it cannot reach a running gateway. It queues a proposal in Sibyl Memory
 * instead, and this polls for them inside the main Ward process.
 *
 * Delivery is not a notification. The proposal's request text is **replayed through
 * the ordinary graph** on the user's own channel, so it hits the same intent parser,
 * the same gate, the same caps and the same confirmation as if they had typed it
 * themselves. Nothing about arriving via MCP makes a spend cheaper to obtain; the
 * only thing the MCP client bought was the user's attention.
 *
 * If nobody confirms, `askConfirm` resolves `null` and the turn refuses — an
 * unanswered proposal moves nothing.
 */

const POLL_MS = 5_000;

export interface ProposalWatcher {
  stop(): void;
  /** Drain once, rather than waiting for the next tick. Returns how many were delivered. */
  drain(): Promise<number>;
}

export function startProposalWatcher(graph: WardGraph, pollMs = POLL_MS): ProposalWatcher {
  let stopped = false;

  const drain = async (): Promise<number> => {
    const pending = await readProposalQueue();
    if (pending.length === 0) return 0;

    const undelivered: Proposal[] = [];
    let delivered = 0;

    for (const proposal of pending) {
      const target = await deliver(graph, proposal);
      if (target) delivered++;
      else undelivered.push(proposal);
    }

    // Re-read before writing: the MCP process may have appended while we worked.
    // Cross-process, this is the one racy window — see the note on the queue in
    // `memory/store.ts`. Keeping anything we did not deliver, plus anything new,
    // means the failure mode is a duplicate rather than a lost proposal.
    const now = await readProposalQueue();
    const handled = new Set(pending.filter((p) => !undelivered.includes(p)).map((p) => p.id));
    await writeProposalQueue(now.filter((p) => !handled.has(p.id)));

    return delivered;
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await drain();
    } catch (error) {
      console.error("proposal delivery failed:", error);
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  // Never hold the process open for the sake of polling.
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    drain,
  };
}

/** Push one proposal to a human channel. Returns the channel it went to, or `null`. */
async function deliver(graph: WardGraph, proposal: Proposal): Promise<Channel | null> {
  // The gate, again, at delivery time: an authorization deleted between proposing
  // and now means there is nothing to confirm.
  if ((await read(proposal.ward_user_id)) === null) {
    console.error(`proposal ${proposal.id}: no authorization record, dropping`);
    return null;
  }

  const accounts = await accountsFor(proposal.ward_user_id);
  const live = new Set(registeredChannels());
  const target = accounts.find((a) => a.channel !== "mcp" && live.has(a.channel));
  if (!target) return null;

  const adapter = await adapterFor(target.channel, target.account_id);
  if (!adapter) return null;

  await adapter.send(
    `An MCP client asked me to do this on your behalf:\n\n> ${proposal.request}\n\n` +
      `I haven't done anything. Here it is under your normal limits —`,
    "rendered",
  );

  await runTurn({
    graph,
    adapter,
    // Its own thread, so a pushed proposal never lands in the middle of whatever
    // conversation the user happens to be having.
    threadId: `${target.channel}:${target.account_id}:proposal:${proposal.id}`,
    userId: proposal.ward_user_id,
    accountId: target.account_id,
    text: proposal.request,
  });

  await appendJournalEvent(
    proposal.ward_user_id,
    "proposal",
    `mcp proposal delivered to ${target.channel}: ${proposal.summary}`,
    { proposal_id: proposal.id, request: proposal.request, delivered_to: target.channel },
    target.channel,
  );

  return target.channel;
}
