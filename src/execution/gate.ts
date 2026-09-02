import type { ActionType, UserAuthorization } from "../../memory/index.ts";

/**
 * The authorization gate — ported from Len3's
 * `x402_service.py::estimate_cost / requires_approval`, generalised to every
 * action type and pointed at Sibyl Memory + the on-chain Spend Permission instead
 * of `SpendingControls` + summed `AgentWalletTransaction` rows.
 *
 * Pure. Every execution path runs this immediately before spending, on FRESH
 * reads (a revocation between confirmation and execution must take effect).
 */

export interface GateInput {
  record: UserAuthorization;
  actionType: ActionType;
  amountUsd: number;
  spentTodayUsd: number;
  /** true if this action type appears in `revocation_log`. */
  revoked: boolean;
  /** null when there is no on-chain Spend Permission (memory-only gate). */
  onchainAllowanceUsd: number | null;
  /** x402 only: has this endpoint been paid before? First-time endpoints need approval. */
  endpointSeen?: boolean;
}

export interface GateResult {
  allow: boolean;
  needsApproval: boolean;
  executableUsd: number;
  reason: string;
}

/** Amounts at or below this auto-execute without a confirmation. Default 0 → everything confirms. */
function autoApproveUsd(): number {
  const raw = Number(process.env.WARD_AUTO_APPROVE_USD ?? "0");
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function evaluateGate(input: GateInput): GateResult {
  const { record, actionType, amountUsd, spentTodayUsd, revoked, onchainAllowanceUsd } = input;
  const caps = record.standing_caps;

  if (revoked) {
    return deny(
      `${actionType.replace(/_/g, " ")} is paused (revocation_log). Lift the pause first.`,
    );
  }

  if (amountUsd > caps.per_action_limit_usd) {
    return deny(`$${amountUsd} is over the $${caps.per_action_limit_usd} per-action limit.`);
  }

  const memoryRemaining = Math.max(0, caps.daily_limit_usd - spentTodayUsd);
  const onchainRemaining =
    onchainAllowanceUsd === null ? Infinity : Math.max(0, onchainAllowanceUsd - spentTodayUsd);
  const executableUsd = Math.min(
    memoryRemaining,
    onchainRemaining === Infinity ? memoryRemaining : onchainRemaining,
  );

  if (executableUsd <= 0) {
    return deny(
      onchainRemaining <= memoryRemaining && onchainAllowanceUsd !== null
        ? "on-chain spend allowance is exhausted for this period."
        : `daily cap reached ($${caps.daily_limit_usd}).`,
    );
  }

  if (amountUsd > executableUsd) {
    const binding =
      onchainAllowanceUsd !== null && onchainRemaining < memoryRemaining
        ? `on-chain allowance ($${onchainRemaining.toFixed(2)} left this period)`
        : `daily cap ($${memoryRemaining.toFixed(2)} left)`;
    return deny(`$${amountUsd} exceeds the ${binding}.`);
  }

  const firstTimeEndpoint = input.endpointSeen === false;
  const conservative = record.risk_label === "conservative";
  const overAutoLimit = amountUsd > autoApproveUsd();

  return {
    allow: true,
    needsApproval: overAutoLimit || firstTimeEndpoint || conservative,
    executableUsd: Math.min(amountUsd, executableUsd),
    reason: "within limits",
  };
}

function deny(reason: string): GateResult {
  return { allow: false, needsApproval: false, executableUsd: 0, reason };
}
