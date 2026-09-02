import { describe, expect, test } from "bun:test";

import { mdToHtml, splitMessage } from "../src/telegram/gateway.ts";

describe("mdToHtml", () => {
  test("escapes HTML then applies formatting", () => {
    expect(mdToHtml("a < b & **bold**")).toBe("a &lt; b &amp; <b>bold</b>");
  });

  test("renders code, italics and links", () => {
    expect(mdToHtml("run `bun test` now")).toBe("run <code>bun test</code> now");
    expect(mdToHtml("this is *important*")).toBe("this is <i>important</i>");
    expect(mdToHtml("[basescan](https://basescan.org/tx/0x1)")).toBe(
      '<a href="https://basescan.org/tx/0x1">basescan</a>',
    );
  });

  test("fenced code block → <pre>", () => {
    expect(mdToHtml("```\nline1\nline2\n```")).toBe("<pre>line1\nline2</pre>");
  });
});

describe("splitMessage", () => {
  test("returns one chunk under the limit", () => {
    expect(splitMessage("short", 100)).toEqual(["short"]);
  });

  test("splits on newlines and stays under the limit", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const chunks = splitMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.join("\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });
});
