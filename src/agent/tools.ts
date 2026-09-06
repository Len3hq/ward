import { tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import { read, readWallet, spentToday } from "../../memory/index.ts";
import { buildAuthorizationContext } from "./prompts.ts";

/**
 * Agent tools. Phase 2 ships one read-only tool so the graph's `agent ⇄ tools`
 * loop is exercised end to end. Execution tools (`generate_wallet`,
 * `grant_permission`, `revoke`, `swap_on_base`, `pay_x402_endpoint`,
 * `discover_x402`, `get_token_price`, `post_acp_job`) arrive in Phases 4–6, each
 * behind the shared authorization gate.
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

  return [readAuthorization];
}

export function toolNodeFor(userId: string): ToolNode {
  return new ToolNode(boundTools(userId));
}

/** Tool names that must pass through the HITL approval interrupt. Empty until Phase 5. */
export const APPROVAL_REQUIRED = new Set<string>();
