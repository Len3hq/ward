import { randomUUID } from "node:crypto";

import {
  readMcpReceipt,
  writeMcpReceipt,
  type ActionType,
  type McpReceipt,
} from "../../memory/index.ts";
import { loadConfig } from "../config.ts";
import { parseIntent, SPEND_ACTIONS } from "../agent/intent.ts";
import { acpProvider } from "../acp/index.ts";
import { resolveX402Call, searchCatalog } from "../execution/catalog.ts";
import { performSpend } from "../execution/perform.ts";
import { notifyAccount } from "../gateway/channels.ts";
import { accountsFor } from "../identity/index.ts";
import { grantSpentToday, liveGrant, tokenRef } from "./grants.ts";

/**
 * MCP-initiated execution (Phase 16.3) — the first path in Ward where a spend
 * happens without a human answering a prompt at that moment.
 *
 * ## Where the authority comes from
 *
 * Not from here. This function *finds* an authority the user already granted and
 * refuses if it cannot: a live grant on the calling token, naming this action type,
 * inside limits the user set from an authenticated DM. It then hands the spend to
 * `performSpend`, which is the same code the chat path runs — same fresh reads, same
 * `evaluateGate`, same provider, same ledger. The grant enters that gate as one more
 * ceiling, so the comparison is `min(grant, memory cap, on-chain allowance)`.
 *
 * ## Why it returns a receipt
 *
 * Settlement can take tens of seconds, long enough for a client to time out and
 * retry. Returning immediately and letting the client poll means a slow chain looks
 * like a slow chain rather than a failure — and the idempotency key makes a retry
 * that does arrive harmless.
 *
 * ## Why every execution is announced
 *
 * Because nobody was asked. The announcement is the only thing standing between a
 * misbehaving client and a user who does not find out until they check. It names the
 * amount, the token and how to revoke, and it goes to every linked human channel.
 */

export type ExecuteResult = { ok: true; receiptId: string } | { ok: false; message: string };

export async function executeForToken(
  userId: string,
  tokenHash: string,
  request: string,
): Promise<ExecuteResult> {
  const grant = await liveGrant(tokenHash);
  if (grant === null) {
    return {
      ok: false,
      message:
        "This client has no live execution grant, so it can't spend. Ask the user to run " +
        '"/mcp grant" on Telegram or Discord, or use ward_propose_action instead.',
    };
  }

  const intent = await parseIntent(request);
  const action = intent.action_type as ActionType;
  if (!SPEND_ACTIONS.has(intent.action_type)) {
    return {
      ok: false,
      message: `That doesn't look like a spend (${intent.action_type}). Nothing was executed.`,
    };
  }
  if (!grant.action_types.includes(action)) {
    return {
      ok: false,
      message:
        `Your grant covers ${grant.action_types.join(", ")} — not ${action}. ` +
        "Nothing was executed.",
    };
  }

  // Resolve amount and target exactly as the chat path's `confirm` node does, so an
  // MCP request and a typed one price the same thing the same way.
  let amountUsd: number;
  let endpoint:
    { name: string; url: string; method: string; body?: unknown; cost_usd: number } | undefined;
  let acpSubject: string | undefined;

  if (action === "x402_data_purchase") {
    const found = await searchCatalog(`${request} ${intent.token ?? ""}`);
    if (!found) return { ok: false, message: "I have no x402 endpoint for that." };
    const call = resolveX402Call(found, intent.token);
    endpoint = {
      name: found.name,
      url: call.url,
      method: call.method,
      body: call.body,
      cost_usd: found.cost_usd,
    };
    amountUsd = found.cost_usd;
  } else if (action === "acp_job") {
    acpSubject = intent.token ?? intent.pair ?? "the token";
    amountUsd = intent.amount_usd ?? loadConfig().acpBudgetUsd;
    await acpProvider().preferredCounterparty("token_risk");
  } else {
    amountUsd = intent.amount_usd ?? 0;
    if (amountUsd <= 0) {
      return { ok: false, message: "How much? Give a USD amount in the request." };
    }
  }

  const receipt: McpReceipt = {
    id: randomUUID(),
    ward_user_id: userId,
    token_hash: tokenHash,
    status: "pending",
    request,
    action_type: action,
    amount_usd: amountUsd,
    tx_hash: null,
    message: "Working on it.",
    created_at: new Date().toISOString(),
    settled_at: null,
  };
  await writeMcpReceipt(receipt);

  // Deliberately not awaited: the caller gets the receipt id now. Errors are caught
  // and written to the receipt, so a rejection can never escape into the transport.
  void settle(receipt, {
    userId,
    actionType: action,
    amountUsd,
    idempotencyKey: receipt.id,
    endpoint,
    pair: intent.pair,
    acpSubject,
    viaToken: tokenHash,
    grant: {
      perActionLimitUsd: grant.per_action_limit_usd,
      dailyLimitUsd: grant.daily_limit_usd,
      spentTodayUsd: await grantSpentToday(userId, tokenHash),
    },
  });

  return { ok: true, receiptId: receipt.id };
}

async function settle(
  receipt: McpReceipt,
  spend: Parameters<typeof performSpend>[0],
): Promise<void> {
  let outcome: Awaited<ReturnType<typeof performSpend>>;
  try {
    outcome = await performSpend(spend);
  } catch (error) {
    outcome = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  await writeMcpReceipt({
    ...receipt,
    status: outcome.ok ? "done" : "failed",
    tx_hash: outcome.ok ? outcome.txHash : null,
    amount_usd: outcome.ok ? outcome.amountUsd : receipt.amount_usd,
    message: outcome.message,
    settled_at: new Date().toISOString(),
  }).catch(() => undefined);

  await announce(receipt, outcome);
}

async function announce(
  receipt: McpReceipt,
  outcome: Awaited<ReturnType<typeof performSpend>>,
): Promise<void> {
  const ref = tokenRef(receipt.token_hash);
  const news = outcome.ok
    ? [
        `MCP client ${ref} just spent $${outcome.amountUsd.toFixed(2)} on your Ward ` +
          `(${receipt.action_type?.replace(/_/g, " ")}), without asking — you granted it that.`,
        "",
        `Request: "${receipt.request}"`,
        outcome.message,
        "",
        `Stop it doing that again: "/mcp revoke ${ref}"`,
      ].join("\n")
    : [
        `MCP client ${ref} tried to spend on your Ward and was refused.`,
        "",
        `Request: "${receipt.request}"`,
        outcome.message,
        "",
        `Nothing moved. "/mcp revoke ${ref}" removes its grant entirely.`,
      ].join("\n");

  for (const account of await accountsFor(receipt.ward_user_id)) {
    if (account.channel === "mcp") continue;
    await notifyAccount(account.channel, account.account_id, news);
  }
}

/** What `ward_receipt` reads. Scoped to the calling token: a receipt is not public. */
export async function receiptFor(
  id: string,
  userId: string,
  tokenHash: string,
): Promise<McpReceipt | null> {
  const receipt = await readMcpReceipt(id);
  if (receipt === null) return null;
  if (receipt.ward_user_id !== userId || receipt.token_hash !== tokenHash) return null;
  return receipt;
}
