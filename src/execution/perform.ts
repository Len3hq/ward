import {
  appendSpend,
  appendX402,
  isRevoked,
  read,
  readWallet,
  spentToday,
  type ActionType,
} from "../../memory/index.ts";
import { loadConfig } from "../config.ts";
import { log, logError } from "../log.ts";
import { walletProvider } from "../wallet/index.ts";
import { runAcpJob } from "./acp.ts";
import { txUrl } from "./explorer.ts";
import { evaluateGate } from "./gate.ts";
import { resolveSwapPair } from "./swap.ts";

/**
 * One spend, from wherever it was authorized.
 *
 * Extracted from `agent/nodes/execute.ts` when MCP execution arrived (Phase 16.3).
 * The graph node is now a thin wrapper around this, and the MCP tool calls the same
 * function — **a second implementation of this sequence is the failure mode to fear
 * most here**, because it is where the gate is enforced against fresh reads.
 *
 * Order of operations, unchanged (ported from Len3's
 * `X402Service.request_premium_data` reserve→check→refresh→deduct):
 *
 * 1. FRESH `read` / `spentToday` / `isRevoked` / on-chain allowance
 * 2. `evaluateGate` — a revocation between authorization and here still blocks
 * 3. execute on Base via the wallet provider
 * 4. `appendSpend` (idempotent on the caller's key) + trust write-back
 * 5. return the tx hash + explorer link
 */
export interface SpendRequest {
  userId: string;
  actionType: ActionType;
  amountUsd: number;
  /** Idempotent on this: a retrying caller must not spend twice. */
  idempotencyKey: string;
  endpoint?: {
    name: string;
    url: string;
    method: string;
    body?: unknown;
    cost_usd: number;
  };
  /** swap only, e.g. "USDC/ETH". */
  pair?: string;
  /** send only: the 0x address the USDC goes to. */
  destination?: string;
  /** acp_job only. */
  acpSubject?: string;
  /**
   * The MCP token spending, when one is (Phase 16). Tags the ledger entry, and
   * brings its grant along as a third ceiling.
   */
  viaToken?: string | null;
  grant?: {
    perActionLimitUsd: number;
    dailyLimitUsd: number;
    spentTodayUsd: number;
  };
}

export type SpendOutcome =
  { ok: true; message: string; txHash: string; amountUsd: number } | { ok: false; message: string };

export async function performSpend(request: SpendRequest): Promise<SpendOutcome> {
  const { userId } = request;
  const started = performance.now();
  log("spend.start", {
    user: userId,
    action: request.actionType,
    amount_usd: request.amountUsd,
    endpoint: request.endpoint?.name,
    pair: request.pair,
    destination: request.destination,
    via_token: request.viaToken ?? undefined,
  });

  const record = await read(userId);
  if (record === null) return { ok: false, message: "Your authorization is gone — I won't act." };

  const spent = await spentToday(userId);
  const wallet = await readWallet(userId);
  const permission = wallet?.spend_permission ?? null;
  // The provider is addressed by the wallet's pinned key, never by the principal —
  // see `nodes/wallet.ts`. Absent only when no wallet was ever connected, which the
  // stub provider tolerates and the CDP provider rejects.
  const accountKey = wallet?.account_key ?? userId;

  // The same precondition `nodes/confirm.ts` states before asking, re-checked here
  // because MCP execution reaches this function without passing through that node.
  if (walletProvider().requiresSpendPermission && (wallet === null || permission === null)) {
    return {
      ok: false,
      message:
        "No on-chain spend permission, so I have no authority to move your USDC — nothing moved. " +
        'Say "generate my wallet" if you have none, then grant a spend permission.',
    };
  }

  let onchainAllowanceUsd: number | null = null;
  if (permission) {
    if (permission.status !== "active") {
      return { ok: false, message: "Spend permission revoked — nothing moved." };
    }
    // Falling back to the remembered allowance is deliberate — a chain read that is
    // merely unreachable must not block a spend the user already confirmed — but it
    // is a fallback, and a silent one hides an RPC outage behind stale numbers.
    const live = await walletProvider()
      .readSpendPermission(accountKey)
      .catch((error: unknown) => {
        logError("spend.permission_unreadable", error, {
          user: userId,
          action: request.actionType,
          note: "using the remembered allowance",
        });
        return null;
      });
    if (live?.status === "revoked") {
      return { ok: false, message: "Spend permission revoked on-chain — nothing moved." };
    }
    onchainAllowanceUsd = live?.allowanceUsd ?? permission.allowance_usd;
  }

  const gate = evaluateGate({
    record,
    actionType: request.actionType,
    amountUsd: request.amountUsd,
    spentTodayUsd: spent,
    revoked: await isRevoked(userId, request.actionType),
    onchainAllowanceUsd,
    endpointSeen: request.endpoint
      ? record.x402_ledger.some((e) => e.url === request.endpoint!.url)
      : undefined,
    grant: request.grant,
  });
  if (!gate.allow) {
    // Worth a line, unlike the ordinary refusals above: in the chat path the gate
    // already passed at confirmation time, so a block HERE means something changed in
    // between — a revocation landing mid-flight, or another surface spending the same
    // cap. `warn`, not `error`: this is the gate working, and `error` should keep
    // meaning something went wrong.
    log("spend.blocked", {
      user: userId,
      action: request.actionType,
      amount_usd: request.amountUsd,
      reason: gate.reason,
      via_token: request.viaToken ?? undefined,
    });
    return { ok: false, message: `Blocked at execution — ${gate.reason} Nothing moved.` };
  }

  const provider = walletProvider();
  const network = loadConfig().baseNetwork;
  const viaToken = request.viaToken ?? null;

  try {
    if (request.actionType === "x402_data_purchase" && request.endpoint) {
      const endpoint = request.endpoint;
      const result = await provider.payX402(accountKey, {
        url: endpoint.url,
        method: endpoint.method,
        body: endpoint.body,
        expectedUsd: endpoint.cost_usd,
        maxUsd: capUsd(endpoint.cost_usd),
      });
      await appendSpend(userId, {
        action_type: "x402_data_purchase",
        amount_usd: result.amountUsd,
        tx_hash: result.txHash,
        idempotency_key: request.idempotencyKey,
        via_token: viaToken,
      });
      await appendX402(userId, { url: endpoint.url, ok: true, amount_usd: result.amountUsd });
      log("spend.ok", {
        user: userId,
        action: "x402_data_purchase",
        endpoint: endpoint.name,
        amount_usd: result.amountUsd,
        tx: result.txHash,
        ms: performance.now() - started,
      });
      return {
        ok: true,
        txHash: result.txHash,
        amountUsd: result.amountUsd,
        message: `Paid $${result.amountUsd} for "${endpoint.name}". ${txUrl(result.txHash, network)}\n\n${preview(result.data)}`,
      };
    }

    if (request.actionType === "swap") {
      // No defaulting: a pair that cannot be honoured is refused, never guessed at.
      // `"ETH"` alone used to become sell ETH → buy ETH, and selling anything but
      // USDC is outside what the Spend Permission authorizes at all.
      const resolved = resolveSwapPair(request.pair);
      if (!resolved.ok) return { ok: false, message: resolved.message };
      const { sell, buy } = resolved.pair;
      const result = await provider.swap(accountKey, {
        sellSymbol: sell,
        buySymbol: buy,
        amountUsd: request.amountUsd,
      });
      await appendSpend(userId, {
        action_type: "swap",
        amount_usd: result.sellUsd,
        tx_hash: result.txHash,
        idempotency_key: request.idempotencyKey,
        via_token: viaToken,
      });
      // Say plainly whether the proceeds actually reached the user. A swap whose
      // output is still sitting in the agent spender is not a completed swap, and
      // reporting it as one would be the most misleading thing Ward could say.
      const landed = result.sweepTx
        ? `Sent to your smart account: ${txUrl(result.sweepTx, network)}`
        : "⚠️ The bought token could not be moved to your smart account — it is still " +
          "held by the agent spender. Nothing further will happen automatically.";
      log("spend.ok", {
        user: userId,
        action: "swap",
        pair: `${sell}/${buy}`,
        amount_usd: result.sellUsd,
        tx: result.txHash,
        swept: result.sweepTx !== undefined,
        ms: performance.now() - started,
      });
      return {
        ok: true,
        txHash: result.txHash,
        amountUsd: result.sellUsd,
        message:
          `Swapped $${result.sellUsd} ${sell.toUpperCase()} → ${buy.toUpperCase()} ` +
          `(${result.buyDisplay}). ${txUrl(result.txHash, network)}\n${landed}`,
      };
    }

    if (request.actionType === "send") {
      const to = request.destination;
      if (!to || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
        return { ok: false, message: "No valid destination address — nothing moved." };
      }
      const result = await provider.sendUsdc(accountKey, {
        to: to as `0x${string}`,
        amountUsd: request.amountUsd,
      });
      await appendSpend(userId, {
        action_type: "send",
        amount_usd: result.amountUsd,
        tx_hash: result.txHash,
        idempotency_key: request.idempotencyKey,
        via_token: viaToken,
      });
      log("spend.ok", {
        user: userId,
        action: "send",
        destination: to,
        amount_usd: result.amountUsd,
        tx: result.txHash,
        ms: performance.now() - started,
      });
      return {
        ok: true,
        txHash: result.txHash,
        amountUsd: result.amountUsd,
        message: `Sent $${result.amountUsd} USDC to ${to}. ${txUrl(result.txHash, network)}`,
      };
    }

    if (request.actionType === "acp_job") {
      const run = await runAcpJob({
        userId,
        accountKey,
        subject: request.acpSubject ?? "the token",
        budgetUsd: request.amountUsd,
        idempotencyKey: request.idempotencyKey,
        viaToken,
      });
      return {
        ok: run.ok,
        txHash: "0x",
        amountUsd: request.amountUsd,
        message: run.message,
      } as SpendOutcome;
    }

    return { ok: false, message: "Nothing to execute." };
  } catch (error) {
    // Say it on the server too, with the stack. This used to return the message to
    // chat and nothing else, so a spend that failed on chain — no gas on the spender,
    // no route for a dust-sized swap — left the only copy of the reason in the user's
    // Telegram thread, and the logs showed a completely healthy process.
    logError("spend.failed", error, {
      user: userId,
      action: request.actionType,
      amount_usd: request.amountUsd,
      pair: request.pair,
      endpoint: request.endpoint?.name,
      via_token: request.viaToken ?? undefined,
      ms: performance.now() - started,
    });
    if (request.endpoint) {
      await appendX402(userId, { url: request.endpoint.url, ok: false, amount_usd: 0 }).catch(
        (writeError: unknown) => logError("x402.write_failed", writeError, { user: userId }),
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Execution failed: ${message}. Nothing was charged beyond gas.` };
  }
}

/**
 * The hard ceiling on what an endpoint may charge: 1.5× the catalogue price.
 *
 * Rounded UP, at USDC's six decimals — not to cents, which is what broke every
 * purchase. Real x402 endpoints charge tenths of a cent: the two Heurist ones cost
 * $0.001, and `Math.round(0.0015 * 100) / 100` is **$0**. So the cap handed to the
 * payment was zero, and the spend refused itself with "the endpoint asks $0.001
 * USDC, over the $0 cap you approved" — while the user had $12 of allowance sitting
 * unused. Money below a cent is normal here; cent-precision arithmetic is not.
 */
function capUsd(costUsd: number): number {
  return Math.ceil(costUsd * 1.5 * 1e6) / 1e6;
}

function preview(data: unknown): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
