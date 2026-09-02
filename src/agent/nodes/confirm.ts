import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";

import { isRevoked, read, readWallet, spentToday, type ActionType } from "../../../memory/index.ts";
import { walletProvider } from "../../wallet/index.ts";
import { describeIntent } from "../intent.ts";
import type { WardStateType } from "../state.ts";

/**
 * The confirm-before-execute step (plain yes/no). Cites the *real* limits and
 * enforces the two-limit design:
 *
 *   executable = min(memory cap remaining, on-chain allowance remaining)
 *
 * Blocks anything over a cap, on a revoked action type, or past a revoked /
 * exhausted on-chain Spend Permission; otherwise `interrupt()`s for confirmation.
 * The gateway shows the prompt and resumes with `Command({ resume: { approved } })`.
 *
 * Phase 4: reads the on-chain allowance. Phase 5 replaces the "confirmed"
 * acknowledgement with the Base execution path behind this same gate.
 */
export async function confirmNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const intent = state.parsedIntent;
  const record = await read(state.tgId);
  if (!intent || record === null) {
    return { messages: [new AIMessage("I lost the thread there — say that again?")] };
  }

  const action = intent.action_type as ActionType;
  const caps = record.standing_caps;
  const spent = await spentToday(state.tgId);
  const memoryRemaining = Math.max(0, caps.daily_limit_usd - spent);
  const amount = intent.amount_usd;
  const summary = describeIntent(intent);

  if (await isRevoked(state.tgId, action)) {
    return {
      messages: [
        new AIMessage(
          `You've paused ${action.replace(/_/g, " ")}. I won't do that until you lift the pause.`,
        ),
      ],
    };
  }

  if (amount !== undefined && amount > caps.per_action_limit_usd) {
    return {
      messages: [
        new AIMessage(
          `That's $${amount}, over your $${caps.per_action_limit_usd} per-action limit. ` +
            "Lower the amount, or raise the cap first.",
        ),
      ],
    };
  }

  // --- on-chain Spend Permission ---
  const wallet = await readWallet(state.tgId);
  const permission = wallet?.spend_permission ?? null;
  let onchainRemaining: number | null = null;
  let onchainLine = "no on-chain permission — memory caps only";

  if (permission) {
    if (permission.status !== "active") {
      return {
        messages: [
          new AIMessage(
            "Your on-chain spend permission is revoked, so I can't move funds — grant a new one first.",
          ),
        ],
      };
    }
    const live = await walletProvider()
      .readSpendPermission(state.tgId)
      .catch(() => null);
    if (live?.status === "revoked") {
      return {
        messages: [
          new AIMessage(
            "Your spend permission was revoked on-chain. I can't move funds until you grant a new one.",
          ),
        ],
      };
    }
    const allowance = live?.allowanceUsd ?? permission.allowance_usd;
    onchainRemaining = Math.max(0, allowance - spent);
    onchainLine = `on-chain allowance $${onchainRemaining.toFixed(2)} remaining`;
  }

  const executable =
    onchainRemaining === null ? memoryRemaining : Math.min(memoryRemaining, onchainRemaining);

  if (amount !== undefined && amount > executable) {
    const binding =
      onchainRemaining !== null && onchainRemaining < memoryRemaining
        ? `your on-chain allowance ($${onchainRemaining.toFixed(2)} left this period)`
        : `your $${caps.daily_limit_usd} daily cap ($${memoryRemaining.toFixed(2)} left)`;
    return {
      messages: [new AIMessage(`$${amount} would exceed ${binding}. Lower the amount.`)],
    };
  }

  const capLine =
    amount !== undefined
      ? `$${spent.toFixed(2)} of your $${caps.daily_limit_usd} daily cap used, $${memoryRemaining.toFixed(2)} left; ${onchainLine}.`
      : `Daily cap $${caps.daily_limit_usd}, $${memoryRemaining.toFixed(2)} left today; ${onchainLine}.`;
  const prompt = `${summary}. ${capLine} Confirm? (yes / no)`;

  const decision = interrupt({
    type: "confirm_action",
    action,
    summary,
    amount_usd: amount,
    executable_usd: amount === undefined ? executable : Math.min(amount, executable),
    text: prompt,
  }) as { approved: boolean };

  if (!decision.approved) {
    return { messages: [new AIMessage("Cancelled — nothing moved.")] };
  }
  return {
    messages: [
      new AIMessage(
        `Confirmed: ${summary}. Execution on Base lands in a later build phase — nothing has moved yet.`,
      ),
    ],
  };
}
