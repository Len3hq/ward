import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import { read, readWallet, spentToday, trustScore } from "../../memory/index.ts";
import { endpointNeedsSubject, loadCatalog } from "../execution/catalog.ts";
import { balanceReport } from "../wallet/balances.ts";
import { validateExternalData } from "./guardrails.ts";
import { buildAuthorizationContext } from "./prompts.ts";

/**
 * Agent tools — all read-only: the authorization record from Sibyl Memory, the
 * wallet's live on-chain balance, the x402 catalogue, and what has actually been
 * spent. Everything that MOVES money is deliberately not a tool: it goes through the
 * router's `confirm → gate → execute` path instead, so no model output can reach a
 * spend without the user confirming it.
 *
 * The read-only set exists because the model cannot describe what it cannot see. A
 * catalogue it has no tool for is a catalogue it will deny the existence of.
 */

/**
 * The `userId` is injected per-call by `boundTools(userId)` rather than exposed to the
 * model — the model must never be able to read another user's authorization.
 */
export function boundTools(userId: string) {
  const readAuthorization = tool(
    async () => {
      const [record, wallet, spent] = await Promise.all([
        read(userId),
        readWallet(userId),
        spentToday(userId),
      ]);
      return buildAuthorizationContext(record, wallet, spent);
    },
    {
      name: "read_authorization",
      description:
        "Read this user's current authorization from Sibyl Memory: risk profile, per-action and daily caps, amount spent today, active revocations, known counterparties, and wallet status. Call this before discussing limits or acting.",
      schema: z.object({}),
    },
  );

  /**
   * The deterministic `balance` intent handles a plain "what's my balance?" without
   * a model at all. This is for the same question in another shape — "can I afford
   * a $20 swap?", "do I have gas?" — where the model has to reason about the number.
   * Without it the model has no balance in front of it and says so, which is what
   * users hit before: "I cannot access that information."
   */
  const readWalletBalance = tool(async () => balanceReport(userId), {
    name: "read_wallet_balance",
    description:
      "Read this user's LIVE on-chain wallet balance on Base: USDC, ETH for gas, their " +
      "spend-permission status and what they have spent today. Call this whenever the user " +
      "asks about their balance, holdings, funds, or whether they can afford something. " +
      "You CAN see their balance — call this rather than saying you cannot.",
    schema: z.object({}),
  });

  /**
   * The catalogue is a local file the operator controls, but its entries were sourced
   * from the x402 Bazaar and `WARD_X402_CATALOG` can repoint it, so the text is
   * wrapped as data on the way out like any other third-party string.
   *
   * The endpoint URL is deliberately withheld. The model never needs it — the spend
   * rail resolves the URL itself from the catalogue id — and it is the one field
   * worth keeping out of a generated message.
   */
  const discoverX402Endpoints = tool(
    async () => {
      const endpoints = await loadCatalog();
      if (endpoints.length === 0) return "The x402 catalogue is empty.";
      const lines = endpoints.map((e) => {
        const subject = endpointNeedsSubject(e) ? " · needs a token symbol or address" : "";
        return `· ${e.name} — ${e.description} ($${e.cost_usd}${subject})`;
      });
      return validateExternalData(
        [
          "x402 endpoints Ward can buy from, and the expected price of each:",
          ...lines,
          "",
          "The real price comes from the endpoint's 402 response and is capped at 1.5× the",
          "figure above. Every purchase is quoted and confirmed before it is paid.",
        ].join("\n"),
        "ward:x402-catalog",
      ).safe;
    },
    {
      name: "discover_x402_endpoints",
      description:
        "List the premium on-chain data endpoints Ward can buy from over x402, with what " +
        "each one returns and what it costs. Call this whenever the user asks what data is " +
        "available, what they can buy, what x402 endpoints exist, or what something costs.",
      schema: z.object({}),
    },
  );

  /**
   * `read_authorization` gives the model the current *state*; this gives it the
   * history behind that state. Ledger rows carry counterparty-supplied text
   * (outcome summaries, endpoint URLs), so it is wrapped as data — same treatment
   * `ward_recent_activity` gives it on the MCP surface.
   */
  const recentActivity = tool(
    async ({ limit }) => {
      const record = await read(userId);
      if (record === null) {
        return "No authorization record for this user, so there is no activity to show.";
      }
      const take = limit ?? 5;
      const lines: string[] = [];

      const spends = record.spent_ledger.slice(-take).reverse();
      lines.push(spends.length === 0 ? "Spends: none yet" : "Spends (newest first):");
      for (const e of spends) {
        // One ledger, several authorities: a spend an MCP client made counts against
        // the same cap, so it has to be distinguishable from one the user made.
        const by = e.via_token === null ? "you" : `client ${e.via_token.slice(0, 8)}`;
        lines.push(`  ${e.ts} · $${e.amount_usd} · ${e.action_type} · by ${by} · ${e.tx_hash}`);
      }

      const x402 = record.x402_ledger.slice(-take).reverse();
      lines.push("", x402.length === 0 ? "x402 purchases: none yet" : "x402 purchases:");
      for (const e of x402) {
        lines.push(`  ${e.ts} · $${e.amount_usd} · ${e.ok ? "ok" : "FAILED"} · ${e.url}`);
      }

      const jobs = record.acp_job_history.slice(-take).reverse();
      lines.push("", jobs.length === 0 ? "ACP jobs: none yet" : "ACP jobs:");
      for (const job of jobs) {
        const trust = await trustScore(userId, job.counterparty_id);
        lines.push(
          `  ${job.ts} · ${job.counterparty_id} · ${job.job_type} · Δtrust ${job.trust_delta} (now ${trust.toFixed(2)})`,
        );
      }

      return validateExternalData(lines.join("\n"), "ward:ledger").safe;
    },
    {
      name: "recent_activity",
      description:
        "What this user has actually spent, bought and hired: the most recent entries from " +
        "the spend ledger, the x402 purchase log and the ACP job history, newest first. Call " +
        "this when the user asks what they have spent, bought, or which agents they have hired.",
      schema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("How many of each list to return. Default 5."),
      }),
    },
  );

  return [readAuthorization, readWalletBalance, discoverX402Endpoints, recentActivity];
}

export function toolNodeFor(userId: string): ToolNode {
  return new ToolNode(boundTools(userId));
}

/**
 * Tool names that must pass through the HITL approval interrupt. Empty by design,
 * not by omission: every tool above is read-only, and spending goes down the
 * `confirm → execute` rail instead. Adding a spending tool means adding it here too.
 */
export const APPROVAL_REQUIRED = new Set<string>();
