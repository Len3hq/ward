import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { HumanMessage } from "@langchain/core/messages";

import { read, readWallet } from "../memory/store.ts";
import { tableIntent } from "../src/agent/intent.ts";
import {
  askAction,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  resume,
  say,
  USER,
  type Graph,
} from "./support.ts";

/**
 * Issue 3: changing the user's AUTHORITY had none of the protection spending has.
 *
 * "How do I grant eth permission" — a question — matched the grant rule on
 * `grant` + `permission`, routed to `walletNode`, and executed a live on-chain grant:
 * gas spent, a USDC permission created when ETH was asked about, an amount nobody
 * named, and no confirmation anywhere. "how do i revoke" was worse still.
 *
 * Two fixes, tested here together because they defend one thing: nothing changes what
 * Ward may do unless the user asked for it AND said yes.
 */

beforeEach(hermeticSetup);
afterEach(hermeticTeardown);

/** Onboarded, with a wallet, but no permission yet. */
async function readyToGrant(thread: string): Promise<Graph> {
  const graph = newGraph();
  await onboard(graph, thread, { daily: 100 });
  await say(graph, thread, "generate my wallet");
  return graph;
}

/**
 * Whether the turn raised a yes/no instead of answering. Asserted directly rather
 * than through `say`, which returns the echoed human message on an interrupt and so
 * cannot tell "answered" from "asked to confirm".
 */
async function raisesConfirmation(graph: Graph, thread: string, text: string): Promise<boolean> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage(text)], userId: USER, channel: "telegram", channelAccountId: "" },
    { configurable: { thread_id: thread } },
  )) as { __interrupt__?: unknown[] };
  return (result.__interrupt__?.length ?? 0) > 0;
}

describe("a question never executes the action it asks about", () => {
  test("asking how to grant a permission grants nothing", async () => {
    const graph = await readyToGrant("q-grant");

    // A question must be ANSWERED, not met with a yes/no — otherwise the confirmation
    // is quietly doing the question guard's job, and the guard could rot unnoticed.
    expect(await raisesConfirmation(graph, "q-grant", "How do I grant eth permission")).toBe(false);

    expect(await readWallet(USER)).not.toBeNull();
    expect((await readWallet(USER))?.spend_permission).toBeNull();
  });

  test("asking how to revoke revokes nothing", async () => {
    const graph = await readyToGrant("q-revoke");

    await say(graph, "q-revoke", "how do i revoke");

    expect((await read(USER))?.revocation_log).toHaveLength(0);
  });

  test("the classifier routes questions to read_only, not to the action", () => {
    for (const question of [
      "How do I grant eth permission",
      "how do i revoke",
      "how do I generate a wallet",
      "should I grant a permission?",
      "what happens if I swap",
      "explain how permissions work",
      "is it possible to sell eth",
      "why would I revoke my permission",
    ]) {
      expect(tableIntent(question)?.action_type).toBe("read_only");
    }
  });

  test("real requests are untouched — including the polite question form", () => {
    // "can you …" is a request wearing a question mark. Defusing it would be a worse
    // bug than the one being fixed.
    expect(tableIntent("can you swap $10 into ETH")?.action_type).toBe("swap");
    expect(tableIntent("grant a $50 daily permission")?.action_type).toBe("grant_permission");
    expect(tableIntent("generate my wallet")?.action_type).toBe("generate_wallet");
    expect(tableIntent("revoke my permission")?.action_type).toBe("revoke");
    expect(tableIntent("pause swaps")?.action_type).toBe("revoke");
  });

  test("balance and cap questions still answer, rather than being swallowed", () => {
    expect(tableIntent("what is my balance")?.action_type).toBe("balance");
    expect(tableIntent("how much have I spent today")?.action_type).toBe("read_only");
    expect(tableIntent("what are my limits")?.action_type).toBe("read_only");
  });
});

describe("granting a permission asks first", () => {
  test("the prompt names the amount, the token and the gas cost", async () => {
    const graph = await readyToGrant("g-ask");

    const prompt = await askAction(graph, "g-ask", "grant a $40 daily permission");

    expect(prompt).toContain("$40 USDC per day");
    expect(prompt).toMatch(/costs? (a little )?gas/i);
    expect(prompt).toMatch(/yes \/ no/i);
    // The agent spender is a shared internal account — never surfaced to the user,
    // who has no reason to see it and every reason to not send funds to it.
    expect(prompt).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  test("declining grants nothing and says so", async () => {
    const graph = await readyToGrant("g-no");

    await askAction(graph, "g-no", "grant a $40 daily permission");
    const reply = await resume(graph, "g-no", false);

    expect(reply).toMatch(/cancelled/i);
    expect(reply).toMatch(/no authority to move your funds/i);
    expect((await readWallet(USER))?.spend_permission).toBeNull();
  });

  test("approving grants exactly what was confirmed", async () => {
    const graph = await readyToGrant("g-yes");

    await askAction(graph, "g-yes", "grant a $40 daily permission");
    const reply = await resume(graph, "g-yes", true);

    expect(reply).toMatch(/granted an on-chain spend permission/i);
    const permission = (await readWallet(USER))?.spend_permission;
    expect(permission?.status).toBe("active");
    expect(permission?.allowance_usd).toBe(40);
    expect(permission?.token).toBe("USDC");
  });
});

describe("revoking stays immediate", () => {
  test("no confirmation stands between the user and stopping Ward", async () => {
    const graph = await readyToGrant("r-now");
    await askAction(graph, "r-now", "grant a $40 daily permission");
    await resume(graph, "r-now", true);

    // Revoke removes authority and fails safe, so friction there costs more than it
    // buys: someone typing this wants it to have happened already.
    expect(await raisesConfirmation(graph, "r-now", "revoke my permission")).toBe(false);

    const reply = await say(graph, "r-now", "revoke my permission");
    expect(reply).toMatch(/revoked/i);
    expect((await readWallet(USER))?.spend_permission?.status).toBe("revoked");
    expect((await read(USER))?.revocation_log.length).toBeGreaterThan(0);
  });
});
