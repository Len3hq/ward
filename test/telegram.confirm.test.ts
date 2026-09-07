import { describe, expect, test } from "bun:test";

/**
 * Why answering on Telegram "hung", and Discord did not.
 *
 * Telegraf's polling loop is:
 *
 *   for await (const updates of this) await Promise.all(updates.map(handleUpdate));
 *
 * It does not fetch the next batch until every handler in the current one has
 * resolved. Ward's handler awaited the whole turn — including the confirmation,
 * which parks for up to ten minutes — so the user's "Yes" was never even fetched
 * from Telegram. Production log, verbatim:
 *
 *   16:10:49.876 confirm.answer answer=none ms=600160.4     ← the 10-minute timeout
 *   16:10:50.055 msg.in text=Yes           pending_confirm=false
 *   16:10:50.056 msg.in text="Yes, purchase it"  pending_confirm=false
 *
 * Three messages delivered in the same millisecond, ten minutes after they were
 * sent, to a Ward that had stopped waiting. Discord was fine because discord.js
 * dispatches each event independently.
 *
 * Buttons alone would NOT have fixed it: a `callback_query` is just another update,
 * queued behind the same barrier. Both halves are asserted here.
 */

const source = await Bun.file("src/telegram/gateway.ts").text();

describe("the text handler must not park the polling loop", () => {
  test("the turn is queued, not awaited inside the handler", () => {
    const queuedAt = source.indexOf("s.queue = s.queue.then(");
    expect(queuedAt).toBeGreaterThan(-1);

    // Exactly one call site, and it sits INSIDE the queued task rather than in the
    // handler body — the difference between a handler that returns in milliseconds
    // and one that holds the polling loop open for ten minutes.
    const callSites = [...source.matchAll(/await runTurn\(/g)];
    expect(callSites).toHaveLength(1);
    expect(callSites[0]!.index).toBeGreaterThan(queuedAt);
  });

  test("turns for one chat still run one at a time", () => {
    // Serialised on the session's promise chain, so two messages cannot interleave
    // in the graph even though neither blocks polling.
    expect(source).toContain("queue: Promise<void>");
    expect(source).toMatch(/queue: Promise\.resolve\(\)/);
  });

  test("a failed turn does not poison the chat's queue", () => {
    expect(source).toMatch(/s\.queue = s\.queue\.catch\(/);
  });
});

describe("click to approve", () => {
  test("the confirmation carries Approve and Cancel buttons", () => {
    expect(source).toContain("inline_keyboard");
    expect(source).toMatch(/callback_data: `ward:\$\{nonce\}:yes`/);
    expect(source).toMatch(/callback_data: `ward:\$\{nonce\}:no`/);
  });

  test("a tap is matched to the question that is actually open", () => {
    // A nonce per question: a tap on a stale prompt cannot answer a newer one.
    expect(source).toMatch(/s\.pending\.nonce !== match\[1\]/);
    expect(source).toContain("That confirmation is no longer open.");
  });

  test("only the account that was asked may answer", () => {
    // Same property Discord checks on its buttons.
    expect(source).toMatch(/String\(ctx\.from\.id\) !== String\(chat\.id\)/);
    expect(source).toContain("That isn't your confirmation.");
  });

  test("answering retracts the buttons, so a decision cannot be replayed", () => {
    expect(source).toContain("editMessageReplyMarkup");
    expect(source).toMatch(/inline_keyboard: \[\]/);
  });

  test("typing yes still works — people type it", () => {
    expect(source).toContain("readAnswer(text)");
    expect(source).toContain("Please answer yes or no, or use the buttons.");
  });
});
