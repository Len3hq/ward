import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";

import { isRevoked, read, spentToday, type ActionType } from "../../../memory/index.ts";
import { describeIntent } from "../intent.ts";
import type { WardStateType } from "../state.ts";

/**
 * The confirm-before-execute step (plain yes/no). Cites the *real* limits from
 * Sibyl Memory, blocks anything already over a cap or on a revoked action type,
 * and otherwise `interrupt()`s for the user's confirmation. The gateway shows the
 * prompt and resumes with `Command({ resume: { approved } })`.
 *
 * Phase 3: on "yes" it acknowledges (nothing to execute yet). Phase 5 replaces
 * the acknowledgement with the Base execution path behind the same gate.
 */
export async function confirmNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const intent = state.parsedIntent;
  const record = await read(state.tgId);
  if (!intent || record === null)
    return { messages: [new AIMessage("I lost the thread there — say that again?")] };

  const action = intent.action_type as ActionType;
  const caps = record.standing_caps;
  const spent = await spentToday(state.tgId);
  const remaining = Math.max(0, caps.daily_limit_usd - spent);
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

  if (amount !== undefined && spent + amount > caps.daily_limit_usd) {
    return {
      messages: [
        new AIMessage(
          `That would take today's spend to $${(spent + amount).toFixed(2)}, over your ` +
            `$${caps.daily_limit_usd} daily cap ($${remaining.toFixed(2)} left).`,
        ),
      ],
    };
  }

  const capLine =
    amount !== undefined
      ? `$${spent.toFixed(2)} of your $${caps.daily_limit_usd} daily cap used, $${remaining.toFixed(2)} left.`
      : `Daily cap $${caps.daily_limit_usd}, $${remaining.toFixed(2)} left today.`;
  const prompt = `${summary}. ${capLine} Confirm? (yes / no)`;

  const decision = interrupt({
    type: "confirm_action",
    action,
    summary,
    amount_usd: amount,
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
