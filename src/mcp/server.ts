import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { executeForToken, receiptFor } from "./execute.ts";
import { grantSpentToday, liveGrant } from "./grants.ts";
import { tokenAccountId } from "./token.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  enqueueProposal,
  isRevoked,
  read,
  readWallet,
  spentToday,
  trustScore,
  type ActionType,
  type LinkedAccount,
  type UserAuthorization,
} from "../../memory/index.ts";
import { validateExternalData } from "../agent/guardrails.ts";
import { parseIntent, SPEND_ACTIONS, type IntentAction } from "../agent/intent.ts";
import { accountsFor } from "../identity/index.ts";
import { resolveToken } from "./token.ts";

/**
 * Ward as an MCP server — the third surface, and the one that tests the thesis
 * hardest.
 *
 * Telegram and Discord prove identity with an account: a DM is already
 * authenticated, so the account *is* the person. An MCP client has neither. It is a
 * local process holding a bearer token, started by whatever wrote that token into a
 * config file. There is nobody on the other end of the stdio pipe to ask.
 *
 * So this surface is propose-only by default, and that default is the design: **there
 * is no
 * `ward_execute` tool.** A client may read the authorization record and it may
 * *propose* a spend, but the proposal is delivered to a human channel and replayed
 * through the ordinary graph there — meeting the same gate, the same caps and the
 * same confirmation a typed message would. A leaked token therefore cannot move
 * money; it can only ask someone to. A token the user has deliberately granted a
 * capped, expiring execution grant is the one exception, and it arrives with its own
 * limits, its own ledger tag and an announcement on every spend (Phase 16.3).
 *
 * That is the deletion gate's argument, extended to a caller who cannot be a person.
 *
 * Setup, in the MCP client's config:
 *
 *   "ward": {
 *     "command": "bun",
 *     "args": ["run", "/path/to/ward/src/mcp/server.ts"],
 *     "env": { "WARD_USER_TOKEN": "wardmcp_…" }
 *   }
 *
 * Mint the token with `/link mcp` in a Telegram or Discord DM. Revoke every token
 * with `/unlink mcp`.
 *
 * See `MULTI-CHANNEL.md` §3.
 */

const NOT_LINKED = [
  "This MCP client isn't linked to a Ward user.",
  "",
  'Send "/link mcp" to Ward on Telegram or Discord, then put the token it gives you',
  "in this server's config as WARD_USER_TOKEN and restart the client.",
].join("\n");

const NO_AUTHORIZATION = [
  "There is no authorization record for this user in Sibyl Memory.",
  "",
  "Ward will not move funds — not even within what the chain would allow — until the",
  "user onboards again (risk profile, per-action limit, daily limit) on a human channel.",
].join("\n");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], isError };
}

/** Never print a token or its digest back to the client that presented it. */
function describeAccount(account: LinkedAccount): string {
  if (account.channel === "mcp") {
    return `mcp:token(…${account.account_id.slice(-6)})`;
  }
  return `${account.channel}:${account.account_id}`;
}

/**
 * `canExecute` decides whether the execution tools exist at all (Phase 16.3).
 *
 * Registration is conditional rather than the tools refusing at call time, so a
 * client with no grant sees exactly the surface it had before 16.3 — and the
 * project's oldest claim, that the tool list contains nothing that can spend, stays
 * literally true for every token that was not granted anything.
 */
export interface McpServerOptions {
  canExecute?: boolean;
}

export function createMcpServer(
  getToken: () => string | undefined,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: "ward", version: "0.0.0" },
    {
      instructions:
        "Ward's authorization record for one user: standing caps, spend ledger, " +
        "revocations, wallet and counterparty trust. This surface is propose-only unless " +
        "the user granted this client an execution grant — it can never approve a spend " +
        "holds a token rather than being a person. Every proposal is confirmed by the " +
        "user on Telegram or Discord.",
    },
  );

  /** Resolve the caller, or hand back the refusal the tool should return verbatim. */
  async function principal(): Promise<{ userId: string } | { refusal: ToolResult }> {
    const token = getToken();
    if (!token) return { refusal: text(NOT_LINKED, true) };
    const userId = await resolveToken(token);
    if (userId === null) {
      return {
        refusal: text(
          `${NOT_LINKED}\n\n(The token presented is not one Ward issued, or it has been revoked.)`,
          true,
        ),
      };
    }
    return { userId };
  }

  /** As above, but also requires a live authorization record — the gate. */
  async function authorized(): Promise<
    { userId: string; record: UserAuthorization } | { refusal: ToolResult }
  > {
    const who = await principal();
    if ("refusal" in who) return who;
    const record = await read(who.userId);
    if (record === null) return { refusal: text(NO_AUTHORIZATION, true) };
    return { userId: who.userId, record };
  }

  server.registerTool(
    "ward_whoami",
    {
      title: "Who is this Ward for",
      description:
        "The Ward principal this client is bound to, every chat account that shares it, " +
        "and whether an authorization record currently exists.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const who = await principal();
      if ("refusal" in who) return who.refusal;

      const [accounts, record] = await Promise.all([accountsFor(who.userId), read(who.userId)]);
      return text(
        [
          `Ward user: ${who.userId}`,
          "",
          "Accounts sharing this authorization:",
          ...accounts.map((a) => `  · ${describeAccount(a)} (${a.linked_via.replace(/_/g, " ")})`),
          "",
          record === null
            ? `Authorization: NONE. ${NO_AUTHORIZATION}`
            : `Authorization: on file (${record.risk_label}, $${record.standing_caps.daily_limit_usd}/day).`,
          "",
          "This client can read and propose. It cannot approve a spend — that happens on a",
          "human channel.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "ward_read_authorization",
    {
      title: "Read the authorization record",
      description:
        "The live record from Sibyl Memory: risk profile, per-action and daily caps, " +
        "spent today, remaining headroom, active revocations, and wallet status. This is " +
        "the same record the agent gates every spend against.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const got = await authorized();
      if ("refusal" in got) return got.refusal;
      const { userId, record } = got;

      const [spent, wallet] = await Promise.all([spentToday(userId), readWallet(userId)]);
      const remaining = Math.max(0, record.standing_caps.daily_limit_usd - spent);
      const permission = wallet?.spend_permission ?? null;

      return text(
        [
          `Risk profile:      ${record.risk_label}`,
          `Per-action limit:  $${record.standing_caps.per_action_limit_usd}`,
          `Daily limit:       $${record.standing_caps.daily_limit_usd}`,
          `Spent today:       $${spent.toFixed(2)}`,
          `Remaining today:   $${remaining.toFixed(2)}`,
          "",
          record.revocation_log.length === 0
            ? "Revocations:       none"
            : `Revocations:       ${[...new Set(record.revocation_log.map((r) => r.action_type))].join(", ")} (paused)`,
          "",
          wallet === null
            ? "Wallet:            not generated yet"
            : `Wallet:            ${wallet.smart_account}`,
          permission === null
            ? "Spend permission:  none on chain — memory caps only"
            : `Spend permission:  ${permission.status}, $${permission.allowance_usd} USDC / ${permission.period_seconds / 86_400}d`,
          "",
          `Entries: ${record.spent_ledger.length} spend, ${record.x402_ledger.length} x402, ${record.acp_job_history.length} ACP.`,
          "",
          // A model that can see its own ceiling stops proposing things it could
          // never do — and a model that cannot see one should not assume it has any.
          ...(await describeOwnGrant(userId, getToken())),
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "ward_recent_activity",
    {
      title: "Recent activity",
      description:
        "The most recent entries from the spend ledger, the x402 purchase log and the " +
        "ACP job history, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("How many of each, default 10"),
      },
    },
    async ({ limit }): Promise<ToolResult> => {
      const got = await authorized();
      if ("refusal" in got) return got.refusal;
      const { userId, record } = got;
      const take = limit ?? 10;

      // Who caused each spend, not just that it happened (Phase 16.4). A user
      // auditing a client needs to tell its spends apart from their own at a glance,
      // and from another client's — one ledger, several authorities.
      const own = tokenAccountId(getToken() ?? "");
      const lines: string[] = [];
      const spends = record.spent_ledger.slice(-take).reverse();
      lines.push(spends.length === 0 ? "Spends: none" : "Spends:");
      for (const e of spends) {
        const by =
          e.via_token === null
            ? "you"
            : e.via_token === own
              ? "this client"
              : `client ${e.via_token.slice(0, 8)}`;
        lines.push(`  ${e.ts}  $${e.amount_usd}  ${e.action_type}  by ${by}  ${e.tx_hash}`);
      }

      const x402 = record.x402_ledger.slice(-take).reverse();
      lines.push("", x402.length === 0 ? "x402 purchases: none" : "x402 purchases:");
      for (const e of x402) {
        lines.push(`  ${e.ts}  $${e.amount_usd}  ${e.ok ? "ok" : "FAILED"}  ${e.url}`);
      }

      const jobs = record.acp_job_history.slice(-take).reverse();
      lines.push("", jobs.length === 0 ? "ACP jobs: none" : "ACP jobs:");
      for (const job of jobs) {
        const trust = await trustScore(userId, job.counterparty_id);
        lines.push(
          `  ${job.ts}  ${job.counterparty_id}  Δ${job.trust_delta}  (trust now ${trust.toFixed(2)})`,
        );
      }

      // Ledger rows carry counterparty-supplied text (outcome summaries, endpoint
      // URLs). It is data, never instruction, and it is wrapped as such on the way out.
      return text(validateExternalData(lines.join("\n"), "ward:ledger").safe);
    },
  );

  server.registerTool(
    "ward_link_status",
    {
      title: "Link status",
      description:
        "Whether this MCP client is bound to a Ward user, and what to do about it if not.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const who = await principal();
      if ("refusal" in who) return who.refusal;
      const accounts = await accountsFor(who.userId);
      const human = accounts.filter((a) => a.channel !== "mcp");
      const record = await read(who.userId);

      return text(
        [
          `Linked to ${who.userId}.`,
          human.length === 0
            ? "No human channel is linked, so a proposal has nowhere to be confirmed."
            : `Proposals will be confirmed on: ${human.map((a) => a.channel).join(", ")}.`,
          record === null ? `\n${NO_AUTHORIZATION}` : "",
          '\nRevoke this and every other MCP token with "/unlink mcp" on a human channel.',
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "ward_propose_action",
    {
      title: "Propose a spend",
      description:
        "Ask the user to approve a spend. This does NOT execute anything: the request is " +
        "delivered to the user on Telegram or Discord and replayed through Ward's normal " +
        "gate there, where they confirm or decline. Returns a proposal id. There is " +
        "deliberately no tool that executes.",
      inputSchema: {
        request: z
          .string()
          .min(3)
          .max(500)
          .describe(
            'What to propose, phrased as the user would say it, e.g. "swap $20 USDC for ETH"',
          ),
      },
    },
    async ({ request }): Promise<ToolResult> => {
      const got = await authorized();
      if ("refusal" in got) return got.refusal;
      const { userId } = got;

      const accounts = await accountsFor(userId);
      const human = accounts.filter((a) => a.channel !== "mcp");
      if (human.length === 0) {
        return text(
          "There is no human channel linked to this Ward, so there is nobody to confirm a " +
            'proposal. Link Telegram or Discord first with "/link".',
          true,
        );
      }

      // Parse only to describe the proposal and to reject obvious non-actions early.
      // Authority comes from the graph when the request is replayed, never from here.
      const intent = await parseIntent(request);
      const action: IntentAction = intent.action_type;
      if (!SPEND_ACTIONS.has(action)) {
        return text(
          `That doesn't look like a spend (${action}). Propose actions that move ` +
            "funds; for anything else the user can just ask Ward directly.",
          true,
        );
      }
      if (await isRevoked(userId, action as ActionType)) {
        return text(
          `The user has revoked ${action}. Ward would refuse this even if they ` +
            "approved it, so it is not worth asking.",
          true,
        );
      }

      const proposal = await enqueueProposal({
        id: randomUUID(),
        ward_user_id: userId,
        created_at: new Date().toISOString(),
        request,
        summary: `${action}${intent.amount_usd ? ` ~$${intent.amount_usd}` : ""}`,
        source_account: "mcp",
      });

      return text(
        [
          `Proposed. id ${proposal.id}`,
          "",
          `Sent to the user on ${human.map((a) => a.channel).join(" / ")} for confirmation.`,
          "Nothing has moved and nothing will unless they approve it there, within their",
          "existing caps. There is no way for this client to approve it.",
        ].join("\n"),
      );
    },
  );

  if (options.canExecute === true) registerExecutionTools(server, getToken, authorized);

  return server;
}

/**
 * The tools that spend. Reached only when the caller holds a live grant, and even
 * then every limit still applies: `performSpend` re-reads memory and re-runs the gate
 * on fresh values, so a revocation between the grant and the call still blocks.
 */
type Authorized = () => Promise<
  { userId: string; record: UserAuthorization } | { refusal: ToolResult }
>;

function registerExecutionTools(
  server: McpServer,
  getToken: () => string | undefined,
  authorized: Authorized,
): void {
  server.registerTool(
    "ward_execute_action",
    {
      title: "Execute a spend within your grant",
      description:
        "Execute a spend the user has granted this client authority for. Returns a receipt " +
        "id immediately — settlement takes time — which you poll with ward_receipt. The " +
        "spend is still bounded by the grant, the user's own caps and their on-chain " +
        "allowance, whichever is lowest, and the user is told about every one.",
      inputSchema: {
        request: z
          .string()
          .min(3)
          .max(500)
          .describe(
            'What to do, phrased as the user would say it, e.g. "buy a risk score on PEPE"',
          ),
      },
    },
    async ({ request }): Promise<ToolResult> => {
      const got = await authorized();
      if ("refusal" in got) return got.refusal;
      const token = getToken();
      if (!token) return text("No token presented.", true);

      const result = await executeForToken(got.userId, tokenAccountId(token), request);
      if (!result.ok) return text(result.message, true);
      return text(
        `Started. Receipt ${result.receiptId} — poll it with ward_receipt. ` +
          "The user has been told this happened.",
      );
    },
  );

  server.registerTool(
    "ward_receipt",
    {
      title: "Check a spend receipt",
      description:
        "The status of a spend started with ward_execute_action: pending, done or failed, " +
        "with the transaction hash once it settles.",
      inputSchema: {
        receipt_id: z.string().min(1).describe("The id ward_execute_action returned"),
      },
    },
    async ({ receipt_id }): Promise<ToolResult> => {
      const got = await authorized();
      if ("refusal" in got) return got.refusal;
      const token = getToken();
      if (!token) return text("No token presented.", true);

      const receipt = await receiptFor(receipt_id, got.userId, tokenAccountId(token));
      if (receipt === null) return text("No such receipt for this client.", true);
      return text(
        [
          `Status:  ${receipt.status}`,
          `Request: ${receipt.request}`,
          receipt.amount_usd === null ? "" : `Amount:  $${receipt.amount_usd}`,
          receipt.tx_hash === null ? "" : `Tx:      ${receipt.tx_hash}`,
          "",
          receipt.message,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  );
}

/**
 * What the *calling token* is allowed to do, as opposed to what the user is.
 *
 * Phase 16.2 ships this read-only: a grant can exist and be described here while
 * still, by construction, permitting nothing — no code path consults it when
 * deciding a spend until 16.3.
 */
async function describeOwnGrant(userId: string, token: string | undefined): Promise<string[]> {
  if (!token) return [];
  const grant = await liveGrant(tokenAccountId(token));
  if (grant === null) {
    return [
      "This client:      read and propose only. It cannot spend.",
      'The user can change that from Telegram or Discord with "/mcp grant".',
    ];
  }
  const spent = await grantSpentToday(userId, grant.token_hash);
  return [
    `This client:      may spend ${grant.action_types.join(", ")}`,
    `  per action:     $${grant.per_action_limit_usd}`,
    `  per day:        $${grant.daily_limit_usd} (spent $${spent.toFixed(2)})`,
    `  expires:        ${grant.expires_at}`,
    "Still bounded by the user's own caps and their on-chain allowance, whichever is lowest.",
  ];
}

/** Entrypoint when run as an MCP stdio server. */
async function main(): Promise<void> {
  const token = process.env.WARD_USER_TOKEN?.trim();
  // Resolved once, at startup: a grant issued later needs a client restart, exactly
  // as a new token does. Registering the tools conditionally is what keeps "there is
  // no tool that spends" literally true for an ungranted client.
  const canExecute = token ? (await liveGrant(tokenAccountId(token))) !== null : false;
  const server = createMcpServer(() => token, { canExecute });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // stdout is the MCP transport — diagnostics must go to stderr.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
