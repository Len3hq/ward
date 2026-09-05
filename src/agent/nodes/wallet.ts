import { AIMessage } from "@langchain/core/messages";

import {
  ACTION_TYPES,
  appendRevocation,
  read,
  readWallet,
  writeWallet,
  type ActionType,
} from "../../../memory/index.ts";
import { walletProvider } from "../../wallet/index.ts";
import type { RevokeScope } from "../intent.ts";
import type { WardStateType } from "../state.ts";

/**
 * Deterministic wallet + authorization actions: `connect_wallet`,
 * `grant_permission`, `revoke`. Calls the wallet provider (CDP or stub), then
 * persists to the `ward.wallet` entity / `revocation_log` so memory and chain
 * agree. No LLM — the router sends these three intents straight here.
 *
 * Note what is handed to the provider: `wallet.account_key`, never `state.userId`.
 * The provider derives its CDP account names from that string, so the user's
 * smart-account address is a function of it. It is minted once here, at connect,
 * and read back from the record forever after — a principal that later changes
 * (or a record migrated from the Telegram-only build) must still resolve to the
 * same on-chain address, or the funds and the spend permission are stranded.
 */
export async function walletNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const intent = state.parsedIntent;
  const record = await read(state.userId);
  if (!intent || record === null) {
    return { messages: [new AIMessage("Let's finish onboarding first.")] };
  }

  const provider = walletProvider();

  if (intent.action_type === "connect_wallet") {
    const existing = await readWallet(state.userId);
    // Reconnecting must land on the same address, so an existing key always wins.
    const accountKey = existing?.account_key ?? state.userId;
    const wallet = await provider.connect(accountKey);
    await writeWallet(state.userId, {
      account_key: accountKey,
      smart_account: wallet.smartAccount,
      agent_spender: wallet.agentSpender,
      spend_permission: existing?.spend_permission ?? null,
    });
    return {
      messages: [
        new AIMessage(
          [
            `Wallet connected on ${provider.network()}.`,
            `Your smart account: ${wallet.smartAccount}`,
            `Agent spender: ${wallet.agentSpender}`,
            `Next: grant a spend permission — say "grant a $${record.standing_caps.daily_limit_usd} daily permission".`,
          ].join("\n"),
        ),
      ],
    };
  }

  if (intent.action_type === "grant_permission") {
    const wallet = await readWallet(state.userId);
    if (!wallet) {
      return { messages: [new AIMessage('Connect a wallet first — say "connect my wallet".')] };
    }
    const allowance = intent.amount_usd ?? record.standing_caps.daily_limit_usd;
    const permission = await provider.grantSpendPermission(wallet.account_key, allowance, 1);
    await writeWallet(state.userId, {
      ...wallet,
      spend_permission: {
        token: "USDC",
        allowance_usd: permission.allowanceUsd,
        period_seconds: permission.periodSeconds,
        granted_tx: permission.grantedTx ?? "pending",
        status: "active",
      },
    });
    return {
      messages: [
        new AIMessage(
          [
            `Granted an on-chain spend permission: $${permission.allowanceUsd} USDC per ${permission.periodSeconds / 86_400} day, spender ${wallet.agent_spender}.`,
            permission.grantedTx ? `tx ${permission.grantedTx}` : "",
            `I now act within min(your $${record.standing_caps.daily_limit_usd} memory cap, this $${permission.allowanceUsd} on-chain allowance). Revoke on-chain any time.`,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      ],
    };
  }

  // revoke
  const scope = (intent.token ?? "permission") as RevokeScope;
  const reason = revokeReason(state);

  if (scope === "permission") {
    const wallet = await readWallet(state.userId);
    let txLine = "";
    if (wallet?.spend_permission && wallet.spend_permission.status === "active") {
      const { txHash } = await provider.revokeSpendPermission(wallet.account_key);
      await writeWallet(state.userId, {
        ...wallet,
        spend_permission: { ...wallet.spend_permission, status: "revoked" },
      });
      txLine = `\nOn-chain revocation tx ${txHash}.`;
    }
    for (const action of ACTION_TYPES) {
      await appendRevocation(state.userId, { action_type: action, reason });
    }
    return {
      messages: [
        new AIMessage(
          `Revoked your spend permission and paused every spend action.${txLine}\nI can't move funds until you grant a new permission.`,
        ),
      ],
    };
  }

  await appendRevocation(state.userId, { action_type: scope as ActionType, reason });
  return {
    messages: [
      new AIMessage(
        `Paused ${scope.replace(/_/g, " ")}. Your on-chain permission is untouched — I just won't take that action.`,
      ),
    ],
  };
}

function revokeReason(state: WardStateType): string {
  const last = [...state.messages].reverse().find((m) => typeof m.content === "string");
  const text = typeof last?.content === "string" ? last.content.trim() : "";
  return text.length > 0 && text.length <= 200 ? text : "user revoked";
}
