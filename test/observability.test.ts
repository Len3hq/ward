import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { z } from "zod";

import { isSmallTalk, llmIntentSchema, parseIntent } from "../src/agent/intent.ts";
import { TypingIndicator } from "../src/gateway/core.ts";
import { log, logError, preview } from "../src/log.ts";
import { withDeadline } from "../src/wallet/cdp.ts";
import {
  FakeAdapter,
  hermeticSetup,
  hermeticTeardown,
  newGraph,
  onboard,
  turnOn,
  USER,
} from "./support.ts";

/**
 * Two complaints, one cause each.
 *
 * "The Railway logs don't show when I text the agent" — nothing logged a message.
 * The only lines a running deployment produced were startup banners and stack
 * traces, so serving people looked exactly like sitting idle.
 *
 * "Telegram takes time to reply" — a turn sent one "typing…" at the start (which
 * expires in about five seconds) and, for anything the intent table missed, made a
 * model call BEFORE the model call that writes the answer.
 */

/** Capture what the logger actually writes. */
function captured(run: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
}

describe("log lines", () => {
  test("are one searchable key=value line per event", () => {
    const [line] = captured(() =>
      log("msg.in", { channel: "telegram", account: "706456243", chars: 24 }),
    );
    expect(line).toContain("event=msg.in");
    expect(line).toContain("channel=telegram");
    expect(line).toContain("account=706456243");
    expect(line).toContain("chars=24");
    expect(line!.split("\n")).toHaveLength(1);
  });

  test("quote values that would otherwise break key=value parsing", () => {
    const [line] = captured(() => log("turn.start", { text: "Swap 0.0001 eth to usdc" }));
    expect(line).toContain('text="Swap 0.0001 eth to usdc"');
  });

  test("skip absent fields rather than printing undefined", () => {
    const [line] = captured(() => log("cmd", { command: "/link", args: undefined }));
    expect(line).not.toContain("undefined");
  });

  test("an error carries the context of the turn it happened in", () => {
    const lines = captured(() =>
      logError("turn.failed", new Error("boom"), { thread: "telegram:1:1" }),
    );
    expect(lines[0]).toContain("event=turn.failed");
    expect(lines[0]).toContain("thread=telegram:1:1");
    expect(lines[0]).toContain("error=boom");
  });

  describe("message text", () => {
    afterEach(() => delete process.env.WARD_LOG_TEXT);

    test("is truncated, never unbounded", () => {
      expect(preview("x".repeat(500)).length).toBeLessThan(200);
    });

    test("can be withheld entirely, and says so", () => {
      process.env.WARD_LOG_TEXT = "0";
      expect(preview("swap $20 usdc for eth")).toBe("(21 chars, text logging off)");
    });
  });
});

describe("a turn logs what happened", () => {
  beforeEach(hermeticSetup);
  afterEach(hermeticTeardown);

  test("start and finish, with the time it took", async () => {
    const graph = newGraph();
    await onboard(graph, "t-log");

    const adapter = new FakeAdapter("telegram");
    const lines = [] as string[];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await turnOn(graph, adapter, {
        thread: "t-log",
        userId: USER,
        accountId: "706456243",
        text: "what are my limits",
      });
    } finally {
      console.log = original;
    }

    const events = lines.filter((l) => l.includes("ward event="));
    expect(events.some((l) => l.includes("event=turn.start"))).toBe(true);
    expect(events.some((l) => l.includes("event=turn.done"))).toBe(true);
    expect(events.some((l) => /event=turn\.done.*ms=\d/.test(l))).toBe(true);
    expect(events.some((l) => l.includes("channel=telegram"))).toBe(true);
  });
});

describe("the typing indicator", () => {
  test("shows immediately and keeps showing while the turn works", async () => {
    const adapter = new FakeAdapter("telegram");
    const typing = new TypingIndicator(adapter, 20);

    typing.start();
    expect(adapter.typingCalls).toBe(1); // immediate, not one interval late

    await new Promise((resolve) => setTimeout(resolve, 70));
    typing.stop();
    const whileWorking = adapter.typingCalls;
    expect(whileWorking).toBeGreaterThan(1);

    // Stopped means stopped: a confirmation can be open for ten minutes, and a bot
    // that appears to type for all of them is worse than one that says nothing.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(adapter.typingCalls).toBe(whileWorking);
  });

  test("start is idempotent — a resumed turn must not stack timers", async () => {
    const adapter = new FakeAdapter("telegram");
    const typing = new TypingIndicator(adapter, 20);
    typing.start();
    typing.start();
    typing.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    typing.stop();
    expect(adapter.typingCalls).toBeLessThan(6);
  });
});

describe("small talk skips the intent model call", () => {
  test("text with nothing money-shaped in it is classified without the LLM", async () => {
    // `source=smalltalk` is the proof no model was called — and it is what makes the
    // skip visible in the `event=intent` log line rather than hidden inside it.
    for (const text of ["hey", "thanks, that's helpful", "who are you"]) {
      expect(isSmallTalk(text)).toBe(true);
      expect((await parseIntent(text)).source).toBe("smalltalk");
    }
  });

  test("anything money-shaped is still parsed properly", () => {
    for (const text of ["send it", "the usual amount", "0x1234", "move a tenner into ether"]) {
      expect(isSmallTalk(text)).toBe(false);
    }
  });
});

describe("a hung CDP call fails fast instead of parking the turn", () => {
  test("resolves normally when the call answers", async () => {
    expect(await withDeadline("balance read", 1_000, async () => 42)).toBe(42);
  });

  test("gives up, and names what it was waiting for", async () => {
    const started = performance.now();
    const hangs = withDeadline("account lookup", 30, () => new Promise<never>(() => {}));

    await expect(hangs).rejects.toThrow(/CDP account lookup did not answer/);
    // The point of the change: seconds, not the 241 seconds measured in the wild.
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a rejection from the call itself is passed through unchanged", async () => {
    await expect(
      withDeadline("balance read", 1_000, () => Promise.reject(new Error("CDP said no"))),
    ).rejects.toThrow("CDP said no");
  });
});

describe("the intent schema OpenAI is asked to fill", () => {
  /**
   * The LLM half of intent parsing never worked in production: `.optional()` fields
   * produce a schema strict structured outputs reject outright ("'required' … Missing
   * 'amount_usd'"), and `parseIntent` caught the 400 and returned `read_only`. So the
   * cost was a wasted round trip per message and a silent loss of classification.
   */
  const json = z.toJSONSchema(llmIntentSchema) as {
    properties: Record<string, unknown>;
    required?: string[];
  };

  test("lists every property as required — strict mode accepts nothing less", () => {
    expect(json.required?.sort()).toEqual(Object.keys(json.properties).sort());
  });

  test("carries no validation keyword strict mode rejects", () => {
    // `.positive()` becomes `exclusiveMinimum`, which is not supported there; the
    // range check lives in `toParsedIntent` instead.
    expect(JSON.stringify(json)).not.toContain("exclusiveMinimum");
    expect(JSON.stringify(json)).not.toContain("minimum");
  });
});
