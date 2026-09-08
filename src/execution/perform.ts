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
import { txLink } from "./explorer.ts";
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
        message:
          [`Paid $${result.amountUsd} for "${endpoint.name}".`, txLink(result.txHash, network)]
            .filter(Boolean)
            .join(" ") + `\n\n${preview(result.data)}`,
      };
    }

    // NOTE: the "swap" and "send" branches are currently unreachable — both actions
    // are disabled at `src/agent/nodes/router.ts` (DISABLED_ACTIONS) and cannot be
    // put on an MCP grant. Kept intact so re-enabling is a routing change only.
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
        ? `Sent to your smart account. ${txLink(result.sweepTx, network, "View the transfer")}`
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
          [
            `Swapped $${result.sellUsd} ${sell.toUpperCase()} → ${buy.toUpperCase()} ` +
              `(${result.buyDisplay}).`,
            txLink(result.txHash, network, "View the swap"),
          ]
            .filter(Boolean)
            .join(" ") + `\n${landed}`,
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
        message: [`Sent $${result.amountUsd} USDC to ${to}.`, txLink(result.txHash, network)]
          .filter(Boolean)
          .join(" "),
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
        // Was hardcoded to the placeholder, so a hire's outcome carried no hash even
        // once one existed. `runAcpJob` returns the funding transfer when there was
        // one; the placeholder stays only for the case where nothing moved on chain.
        txHash: run.txHash ?? "0x",
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
    // "Nothing was charged beyond gas" is a claim about the chain, and it was made
    // unconditionally — including for a failure that had already pulled the user's
    // USDC into the agent spender. The provider marks the errors where it has
    // accounted for the money, and those messages speak for themselves.
    const accounted = typeof error === "object" && error !== null && "moneyAccounted" in error;
    return {
      ok: false,
      message: `Execution failed: ${message}.${accounted ? "" : " Nothing was charged beyond gas."}`,
    };
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

/**
 * What the user paid for, as something readable in a chat.
 *
 * It used to be `JSON.stringify(data, null, 2)` pasted straight into the message,
 * which arrives as an unformatted wall of braces:
 *
 *   { "result": { "data": { "lookback_days": 3, "summaries": [] } } }
 *
 * Two things wrong with that. It is not fenced, so neither channel renders it as
 * data — Discord reflows it and Telegram runs it together. And the interesting fact
 * about that particular payload is buried in the punctuation: the user paid for a
 * list that came back empty, which is worth a sentence.
 */
export function preview(data: unknown): string {
  if (typeof data === "string") {
    const text = data.trim();
    return text.length === 0 ? EMPTY_PAYLOAD : clip(text);
  }
  if (isEmptyPayload(data)) return EMPTY_PAYLOAD;

  // A table of rows is the common answer — every Nansen endpoint returns
  // `{ data: [...], pagination: {...} }` — and pretty-printed JSON is the worst way
  // to read one. Twenty rows of twenty-three fields clipped at 1200 characters showed
  // the user two rows of punctuation and then a "…". Render it as rows when it is
  // rows; fall back to JSON only for shapes this cannot recognise.
  const rows = tabularRows(data);
  if (rows) return renderRows(rows);

  const json = ["```json", clip(JSON.stringify(data, null, 2)), "```"].join("\n");
  const empty = emptyFields(data);
  if (empty.length === 0) return json;
  return `${json}\n(${empty.map((f) => `\`${f}\``).join(", ")} came back empty.)`;
}

/** The list of records inside whatever envelope the endpoint wrapped it in. */
function tabularRows(data: unknown): Record<string, unknown>[] | null {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const looksLikeRows = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every(isRecord);

  if (looksLikeRows(data)) return data;
  if (!isRecord(data)) return null;
  for (const key of ["data", "results", "items", "rows"]) {
    if (looksLikeRows(data[key])) return data[key];
  }
  return null;
}

/** `0x4200…0006` — an address the user can recognise without 42 characters of it. */
function shortenAddress(value: string): string {
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * One field, as a person would write it. USD gets a dollar sign and a magnitude
 * suffix, percentages a `%`, addresses a middle ellipsis — the raw values are
 * `1234567.8912` and `0.0342`, which say much less at a glance.
 */
function formatValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.length === 0 ? null : value.slice(0, 3).join(", ");
  if (typeof value === "object") return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return shortenAddress(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  const n: number = value;
  const magnitude = (v: number): string => {
    const abs = Math.abs(v);
    if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return abs >= 1 ? String(Number(v.toFixed(2))) : String(Number(v.toPrecision(4)));
  };

  // Units come from the NAME, never the value. Deciding by magnitude — "small enough
  // to be a ratio" — rendered `balance_change_24h` as `-12.0K` in one row and `0.00%`
  // in the next, so the same column carried two different units down the page.
  // A share and a change are both percentages, but only one of them has a direction:
  // "+8.12%" of the supply reads as a gain when it is simply how much they hold.
  if (/^price_change$|_change_pct$/.test(key)) {
    return `${n > 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
  }
  if (/percentage|_pct|percent/.test(key)) return `${(n * 100).toFixed(2)}%`;
  // Counts and durations are integers. `token age days 412.00` is a decimal point
  // pretending to a precision that does not exist.
  if (/_days$|_hours$|^nof_|_count$|^rank$/.test(key)) return String(Math.round(n));
  // Dollars only where the name says dollars. `token_amount` is a quantity of tokens,
  // and `$12.50M` of a memecoin is a different claim from 12.5M of it.
  if (/_usd$|^price$|market_cap|liquidity|volume|fdv|flow/.test(key)) {
    return `${n < 0 ? "-" : ""}$${magnitude(Math.abs(n))}`;
  }
  return magnitude(n);
}

/** Field names that identify the row, so they lead it. */
const LABEL_FIELDS = /symbol|_label$|^name$|^chain$|address/;

/**
 * A field that says what a field already shown says.
 *
 * The screener returns `token_age_days`, `token_age_hours` AND
 * `token_deployment_date` — one fact, three columns, and between them they took three
 * of the row's slots while price, volume and net flow were cut. Age in hours is the
 * same age; the deployment date is the same age with more characters.
 */
function isRedundant(key: string, row: Record<string, unknown>): boolean {
  if (/_hours$/.test(key) && `${key.slice(0, -6)}_days` in row) return true;
  if (/deployment_date|_date$/.test(key) && Object.keys(row).some((k) => /_age_days$/.test(k))) {
    return true;
  }
  return false;
}

/**
 * How much a column earns its place. The row has six slots and the endpoint may offer
 * twenty-three; object order is the API's convenience, not the reader's interest.
 */
function fieldRank(key: string): number {
  if (/_usd$|market_cap|liquidity|volume|flow|price|pnl|value|profit/.test(key)) return 3;
  if (/_change|percentage|ownership|holders?|_amount$|balance/.test(key)) return 2;
  if (/^nof_|_count$|_days$/.test(key)) return 1;
  return 0;
}

function renderRows(rows: Record<string, unknown>[]): string {
  const shown = rows.slice(0, MAX_PREVIEW_ROWS);
  const lines = shown.map((row, index) => {
    const entries = Object.entries(row)
      .map(([key, value]) => [key, formatValue(key, value)] as const)
      .filter((pair): pair is readonly [string, string] => pair[1] !== null);

    const labels = entries.filter(([key]) => LABEL_FIELDS.test(key));
    const rest = entries
      .filter(([key]) => !LABEL_FIELDS.test(key))
      .filter(([key]) => !isRedundant(key, row))
      .sort((a, b) => fieldRank(b[0]) - fieldRank(a[0]))
      .slice(0, MAX_FIELDS_PER_ROW);
    const head = labels.map(([, v]) => v).join(" · ") || `row ${index + 1}`;
    const body = rest.map(([key, v]) => `${key.replace(/_/g, " ")} ${v}`).join(" · ");
    return body ? `${index + 1}. ${head}\n   ${body}` : `${index + 1}. ${head}`;
  });

  const more = rows.length > shown.length ? `\n\n…and ${rows.length - shown.length} more.` : "";
  return clip(
    `${rows.length} result${rows.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}${more}`,
  );
}

const EMPTY_PAYLOAD =
  "The endpoint answered with no data for that request — the payment settled, but " +
  "there is nothing to show. Worth trying a different endpoint, or the same one later.";

/**
 * The user paid for these rows, so they get these rows. Both channels split a long
 * message on their own (4096 on Telegram, 2000 on Discord), so the old 1200-character
 * clip was not protecting anything — it just threw away three quarters of a purchase
 * and printed "…and 15 more."
 */
const MAX_PREVIEW_CHARS = 6000;
/** Rows a chat message can carry before it stops being readable. */
const MAX_PREVIEW_ROWS = 30;
/** Columns per row. Nansen returns up to 23; nobody reads 23 on a phone. */
const MAX_FIELDS_PER_ROW = 6;
/** Enough to name what was missing without listing a whole schema back at the user. */
const MAX_EMPTY_FIELDS = 4;

function clip(text: string): string {
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS)}…` : text;
}

/**
 * Whether the payload carries nothing at all, through however many wrappers the
 * endpoint uses (`{ result: { data: … } }`). A number or a boolean counts as
 * content: for a price endpoint, a number IS the product.
 */
function isEmptyPayload(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data === "string") return data.trim().length === 0;
  if (typeof data === "number" || typeof data === "boolean") return false;
  if (Array.isArray(data)) return data.every(isEmptyPayload);
  if (typeof data === "object") {
    const values = Object.values(data as Record<string, unknown>);
    return values.length === 0 || values.every(isEmptyPayload);
  }
  return false;
}

/**
 * Names of fields that came back as an empty list or an empty string.
 *
 * Deliberately narrower than "is this payload useful?" — that judgement needs to
 * know the endpoint, and getting it wrong in the other direction would print "no
 * data" above a payload full of data. An empty `summaries` is a fact either way.
 */
function emptyFields(data: unknown, found: string[] = []): string[] {
  if (found.length >= MAX_EMPTY_FIELDS || data === null || typeof data !== "object") return found;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (found.length >= MAX_EMPTY_FIELDS) break;
    if (Array.isArray(value) && value.length === 0) found.push(key);
    else if (typeof value === "string" && value.trim().length === 0) found.push(key);
    else if (value && typeof value === "object") emptyFields(value, found);
  }
  return found;
}
