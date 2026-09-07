import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";

import {
  isAmbiguous,
  rankCatalog,
  resetCatalog,
  resolveX402Call,
} from "../src/execution/catalog.ts";
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
 * Discovery outgrew "one best match".
 *
 * With fifteen catalogue entries, "what is smart money buying on base" honestly
 * describes six of them at three different prices — and the single-match search
 * silently picked whichever scored highest, which was measurably the wrong one: the
 * older entry wins on shared tags. The user pays for a guess they never saw made.
 *
 * So `confirm` offers the close ones and waits. Nothing here spends: choosing is a
 * read, and the price confirmation still stands between the choice and the money.
 */

const AMBIGUOUS = path.join(import.meta.dir, "fixtures", "x402-catalog-ambiguous.json");
const WETH = "0x4200000000000000000000000000000000000006";

beforeEach(async () => {
  await hermeticSetup();
  process.env.WARD_X402_CATALOG = AMBIGUOUS;
  resetCatalog();
});
afterEach(async () => {
  await hermeticTeardown();
  resetCatalog();
});

/** Onboarded, wallet connected, permission granted — ready to be offered a choice. */
async function ready(thread: string): Promise<Graph> {
  const graph = newGraph();
  await onboard(graph, thread, { perAction: 50, daily: 100 });
  await say(graph, thread, "generate my wallet");
  await askAction(graph, thread, "grant a $50 daily permission");
  await resume(graph, thread, true);
  return graph;
}

/** One turn, reporting either the confirmation prompt or the plain reply. */
async function turn(
  graph: Graph,
  thread: string,
  text: string,
): Promise<{ confirmation?: string; reply: string }> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage(text)], userId: USER, channel: "telegram", channelAccountId: "" },
    { configurable: { thread_id: thread } },
  )) as {
    __interrupt__?: Array<{ value: { text: string } }>;
    messages: Array<{ content: unknown; constructor: { name: string } }>;
  };
  const ai = [...result.messages].reverse().find((m) => m.constructor.name === "AIMessage");
  return {
    confirmation: result.__interrupt__?.[0]?.value.text,
    reply: typeof ai?.content === "string" ? ai.content : "",
  };
}

describe("ranking", () => {
  test("a query that fits several endpoints is ambiguous", async () => {
    const ranked = await rankCatalog("smart money on base");
    expect(ranked.length).toBeGreaterThanOrEqual(3);
    expect(isAmbiguous(ranked)).toBe(true);
  });

  test("naming an endpoint outright is not ambiguous", async () => {
    const ranked = await rankCatalog("dear smart money");
    expect(ranked[0]!.endpoint.id).toBe("dear-smart-money");
    expect(isAmbiguous(ranked)).toBe(false);
  });

  test("a query matching nothing ranks nothing", async () => {
    expect(await rankCatalog("weather in lagos")).toEqual([]);
  });
});

describe("being offered the options", () => {
  test("an ambiguous request lists them with prices, and buys nothing", async () => {
    const graph = await ready("ch1");

    const { confirmation, reply } = await turn(graph, "ch1", "what is smart money buying on base");

    expect(confirmation).toBeUndefined(); // nothing to confirm — nothing was chosen
    expect(reply).toContain("Which one?");
    expect(reply).toContain("Cheap Smart Money");
    expect(reply).toContain("Dear Smart Money");
    expect(reply).toContain("$0.001");
    expect(reply).toContain("$0.05");
  });

  test("picking by number confirms that endpoint, at its own price", async () => {
    const graph = await ready("ch2");
    const offered = await turn(graph, "ch2", "what is smart money buying on base");
    // The list is alphabetical by score then id: Cheap, Dear, Mid.
    const second = offered.reply.split("\n").find((l) => l.startsWith("2."))!;

    const { confirmation } = await turn(graph, "ch2", "2");

    expect(confirmation).toBeDefined();
    expect(second).toContain(confirmation!.match(/Buy "([^"]+)"/)![1]!);
  });

  test("picking by name works too", async () => {
    const graph = await ready("ch3");
    await turn(graph, "ch3", "what is smart money buying on base");

    const { confirmation } = await turn(graph, "ch3", "dear smart money");

    expect(confirmation).toContain('Buy "Dear Smart Money"');
    expect(confirmation).toContain("$0.05");
  });

  test("a number outside the list is not a selection", async () => {
    const graph = await ready("ch4");
    await turn(graph, "ch4", "what is smart money buying on base");

    const { confirmation } = await turn(graph, "ch4", "9");

    expect(confirmation).toBeUndefined();
  });

  /**
   * The subject has to survive the detour. Before it did, choosing an endpoint that
   * needs a token address re-asked for one the user had already given.
   */
  test("the token address carries through the choice", async () => {
    const graph = await ready("ch5");
    const offered = await turn(graph, "ch5", `smart money holders for ${WETH}`);
    expect(offered.reply).toContain("Which one?");

    const { confirmation, reply } = await turn(graph, "ch5", "holders only");

    expect(reply).not.toContain("Which token?");
    expect(confirmation).toContain('Buy "Holders Only"');
  });
});

describe("an unambiguous request still goes straight through", () => {
  test("no list, just the price", async () => {
    const graph = await ready("ch6");

    const { confirmation, reply } = await turn(graph, "ch6", "dear smart money");

    expect(reply).not.toContain("Which one?");
    expect(confirmation).toContain('Buy "Dear Smart Money"');
  });
});

describe("data requests are questions, and must survive the interrogative guard", () => {
  test("asking what smart money is doing is a purchase, not a refusal", () => {
    // The guard that stops "how do I grant a permission?" from granting one was
    // swallowing these: a data request is ASKED for, and every one of them was
    // being answered with a recital of the caps instead.
    for (const q of [
      "what is smart money buying on base",
      "what is the netflow on base",
      "who holds this token",
      "who bought AERO",
    ]) {
      expect(tableIntent(q)?.action_type).toBe("x402_data_purchase");
    }
  });

  /**
   * Asking what is on the menu must never cost money. In production, "What onchain
   * data sources do you have" matched `on-chain data` and came back "Buy 'Nansen
   * Smart Money Holdings' (~$0.05). Confirm?" — a price quote in answer to a question
   * about the price list.
   */
  test("asking what data sources exist is answered, not sold", () => {
    for (const q of [
      "What onchain data sources do you have",
      "what data sources do you have",
      "which endpoints are available",
      "list your data sources",
      "what can you buy",
      "show me the endpoints",
    ]) {
      expect(tableIntent(q)?.action_type).toBe("read_only");
    }
  });

  test("asking FOR data still buys it — the menu rule must not swallow requests", () => {
    for (const q of ["what is smart money buying on base", "risk score on PEPE", "token holders"]) {
      expect(tableIntent(q)?.action_type).toBe("x402_data_purchase");
    }
  });

  test("authority questions are still blocked — the exemption is data only", () => {
    for (const q of [
      "how do I grant eth permission",
      "how do i revoke",
      "should I grant a permission?",
    ]) {
      expect(tableIntent(q)?.action_type).toBe("read_only");
    }
  });
});

describe("date placeholders", () => {
  test("a required date range becomes a rolling window, not a stale literal", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    const call = resolveX402Call(
      {
        id: "d",
        name: "d",
        description: "d",
        url: "https://example.test/d",
        method: "POST",
        body_template: { date: { from: "{date_from}", to: "{date_to}" } },
        subject_kind: "any",
        cost_usd: 0.01,
        tags: [],
      },
      undefined,
      now,
    );
    const body = JSON.stringify(call.body);
    expect(body).not.toContain("{date_from}");
    expect(body).not.toContain("{date_to}");

    /**
     * Second precision, and this is not cosmetic. `toISOString()` emits
     * `2026-09-07T12:00:00.000Z`; Nansen's own example bodies use
     * `2025-01-01T00:00:00Z`, and it answered `422 Invalid parameter` to the
     * millisecond form — after taking the money. Seven catalogue entries carry a
     * date, so the wrong format is seven paid failures, not one.
     */
    const dates = (call.body as { date: { from: string; to: string } }).date;
    expect(dates.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(dates.to).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(dates.to).toBe("2026-09-07T12:00:00Z");
    expect(dates.from).toBe("2026-08-31T12:00:00Z"); // the seven-day window
  });
});
