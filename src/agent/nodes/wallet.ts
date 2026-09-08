import { AIMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";

import {
  ACTION_TYPES,
  appendRevocation,
  read,
  readWallet,
  writeWallet,
  type ActionType,
} from "../../../memory/index.ts";
import { loadConfig } from "../../config.ts";
import { txLink } from "../../execution/explorer.ts";
import { balanceReport } from "../../wallet/balances.ts";
import { walletProvider } from "../../wallet/index.ts";
import type { RevokeScope } from "../intent.ts";
import type { WardStateType } from "../state.ts";

/**
 * Deterministic wallet + authorization actions: `generate_wallet`,
 * `grant_permission`, `revoke`, `balance`. Calls the wallet provider (CDP or stub), then
 * persists to the `ward.wallet` entity / `revocation_log` so memory and chain
 * agree. No LLM — the router sends these intents straight here.
 *
 * `grant_permission` interrupts for a yes/no first; the other three do not. See the
 * comment at that branch for why granting is the one that has to ask.
 *
 * `balance` is here rather than in the model's hands for the same reason: a number
 * the user acts on must be read from chain, never produced by a model that has only
 * the authorization block in front of it. Before it existed, "what is my balance?"
 * got "I cannot access that information".
 *
 * Note what is handed to the provider: `wallet.account_key`, never `state.userId`.
 * The provider derives its CDP account names from that string, so the user's
 * smart-account address is a function of it. It is minted once here, at connect,
 * and read back from the record forever after — a principal that later changes
 * (or a record migrated from the Telegram-only build) must still resolve to the
 * same on-chain address, or the funds and the spend permission are stranded.
 */
/**
 * A CDP smart-account user operation pays its own gas unless `CDP_PAYMASTER_URL`
 * sponsors it, so a freshly generated account fails its FIRST grant with an
 * opaque 400 — `insufficient balance to perform useroperation: precheck failed`.
 * Left alone the gateway renders that as "Something went wrong on my side",
 * which sends the operator to the logs to learn they need a few cents of ETH.
 */
export function isGasShortfall(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /insufficient balance|precheck failed|prefund|didn't pay prefund/i.test(message);
}

function gasFundingHelp(smartAccount: string): string {
  return [
    `${smartAccount} holds no ETH, and nothing is sponsoring its gas.`,
    "Either send it a small amount of ETH on Base (a few cents covers many operations),",
    "or set CDP_PAYMASTER_URL so CDP sponsors it and you only ever hold USDC.",
  ].join("\n");
}

export async function walletNode(state: WardStateType): Promise<Partial<WardStateType>> {
  const intent = state.parsedIntent;
  const record = await read(state.userId);
  if (!intent || record === null) {
    return { messages: [new AIMessage("Let's finish onboarding first.")] };
  }

  const provider = walletProvider();

  if (intent.action_type === "generate_wallet") {
    const existing = await readWallet(state.userId);
    // Re-generating must land on the same address, so an existing key always wins.
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
            `Wallet generated on ${provider.network()}.`,
            `Your smart account: ${wallet.smartAccount}`,
            `Agent spender: ${wallet.agentSpender}`,
            `Next: grant a spend permission — say "grant a $${record.standing_caps.daily_limit_usd} daily permission".`,
          ].join("\n"),
        ),
      ],
    };
  }

  if (intent.action_type === "balance") {
    return { messages: [new AIMessage(await balanceReport(state.userId))] };
  }

  if (intent.action_type === "grant_permission") {
    const wallet = await readWallet(state.userId);
    if (!wallet) {
      return { messages: [new AIMessage('Generate a wallet first — say "generate my wallet".')] };
    }
    const allowance = intent.amount_usd ?? record.standing_caps.daily_limit_usd;

    // Granting is the one action that ENLARGES what Ward may do, and it is a real
    // transaction that costs gas. Spends have confirmed since Phase 5; this did not,
    // which is how "How do I grant eth permission" executed a live grant — a question
    // that changed the user's authority and answered a different one than it asked.
    //
    // `revoke` deliberately stays immediate. It only ever REMOVES authority and fails
    // safe, so friction there costs more than it buys: someone typing "revoke
    // everything" wants it to have happened already.
    //
    // On resume LangGraph re-enters this node from the top, so everything above must
    // stay read-only — it runs twice.
    const decision = interrupt({
      type: "confirm_action",
      action: "grant_permission",
      summary: `Grant $${allowance} USDC per day to ${wallet.agent_spender}`,
      amount_usd: allowance,
      text: [
        `Grant an on-chain spend permission: $${allowance} USDC per day, spender ${wallet.agent_spender}.`,
        `This is a transaction on ${provider.network()} and costs gas.`,
        `It lets me move up to that much USDC without asking again — x402 data and ACP hires draw on it.`,
        `Confirm? (yes / no)`,
      ].join("\n"),
    }) as { approved: boolean };

    if (!decision.approved) {
      return {
        messages: [
          new AIMessage(
            "Cancelled — nothing was granted, and I still have no authority to move your funds.",
          ),
        ],
      };
    }

    let permission;
    try {
      permission = await provider.grantSpendPermission(wallet.account_key, allowance, 1);
    } catch (error) {
      if (!isGasShortfall(error)) throw error;
      return {
        messages: [
          new AIMessage(
            `I couldn't grant the permission — the transaction has no gas.\n${gasFundingHelp(wallet.smart_account)}\nNothing was granted, so I still can't spend anything.`,
          ),
        ],
      };
    }
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
    let txNote = "";
    if (wallet?.spend_permission && wallet.spend_permission.status === "active") {
      try {
        const { txHash } = await provider.revokeSpendPermission(wallet.account_key);
        await writeWallet(state.userId, {
          ...wallet,
          spend_permission: { ...wallet.spend_permission, status: "revoked" },
        });
        // Was a bare hash printed into the sentence — 66 characters nobody reads and
        // nothing to tap. Same treatment as every other receipt.
        txNote = `\nRevoked on chain. ${txLink(txHash, loadConfig().baseNetwork, "View the revocation")}`;
      } catch (error) {
        if (!isGasShortfall(error)) throw error;
        // Fail closed. The memory revocation below still stops every spend, and
        // Ward is the only spender — but say plainly that the chain side did not
        // land, rather than reporting a revocation that only half happened.
        txNote =
          `\n⚠️ The on-chain revocation did NOT land: ${gasFundingHelp(wallet.smart_account)}\n` +
          "The permission is still live on-chain. I've paused every spend action in memory, so I won't use it.";
      }
    }
    for (const action of ACTION_TYPES) {
      await appendRevocation(state.userId, { action_type: action, reason });
    }
    return {
      messages: [
        new AIMessage(
          `Revoked your spend permission and paused every spend action.${txNote}\nI can't move funds until you grant a new permission.`,
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
