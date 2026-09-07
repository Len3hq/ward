import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import { read, readWallet, spentToday } from "../../memory/index.ts";
import { balanceReport } from "../wallet/balances.ts";
import { buildAuthorizationContext } from "./prompts.ts";

/**
 * Agent tools — both read-only: the authorization record from Sibyl Memory, and the
 * wallet's live on-chain balance. Everything that MOVES money is deliberately not a
 * tool: it goes through the router's `confirm → gate → execute` path instead, so no
 * model output can reach a spend without the user confirming it.
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

  return [readAuthorization, readWalletBalance];
}

export function toolNodeFor(userId: string): ToolNode {
  return new ToolNode(boundTools(userId));
}

/** Tool names that must pass through the HITL approval interrupt. Empty until Phase 5. */
export const APPROVAL_REQUIRED = new Set<string>();
