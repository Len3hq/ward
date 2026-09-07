import { describe, expect, test } from "bun:test";

import { markCopyable } from "../src/gateway/format.ts";
import { render } from "../src/telegram/gateway.ts";

/**
 * Issue 2: a wallet address has to leave the chat. Nobody retypes 42 hex characters
 * correctly on a phone, and getting one wrong loses money — so every channel renders
 * an address as whatever its own copyable text is.
 */

const ADDRESS = "0xdEC85Eff491CFA70DB91B71B7D62a13994d01357";

describe("markCopyable — inline (Telegram)", () => {
  test("wraps a bare address in code", () => {
    expect(markCopyable(`Your wallet address is ${ADDRESS}.`, "inline")).toBe(
      `Your wallet address is \`${ADDRESS}\`.`,
    );
  });

  test("leaves an address that is already code alone", () => {
    const already = `Your wallet \`${ADDRESS}\` on base`;
    expect(markCopyable(already, "inline")).toBe(already);
  });

  test("leaves an address inside a markdown link alone", () => {
    const link = `[View](https://basescan.org/address/${ADDRESS})`;
    expect(markCopyable(link, "inline")).toBe(link);
  });

  test("leaves an address inside a fenced block alone", () => {
    const fenced = "```\n" + ADDRESS + "\n```";
    expect(markCopyable(fenced, "inline")).toBe(fenced);
  });

  test("marks every address in a multi-address message", () => {
    const text = `Your smart account: ${ADDRESS}\nAgent spender: ${ADDRESS}`;
    expect([...markCopyable(text, "inline").matchAll(/`0x/g)]).toHaveLength(2);
  });
});

describe("markCopyable — block (Discord)", () => {
  test("moves the address into a fenced block, dropping the stranded full stop", () => {
    expect(markCopyable(`Your wallet address is ${ADDRESS}.`, "block")).toBe(
      `Your wallet address is\n\`\`\`\n${ADDRESS}\n\`\`\`\n`,
    );
  });

  test("an address written as inline code becomes a block, not monospaced text", () => {
    expect(markCopyable(`Your wallet \`${ADDRESS}\` on base:`, "block")).toBe(
      `Your wallet\n\`\`\`\n${ADDRESS}\n\`\`\`\non base:`,
    );
  });

  test("leaves an address inside a markdown link alone", () => {
    const link = `[View](https://basescan.org/address/${ADDRESS})`;
    expect(markCopyable(link, "block")).toBe(link);
  });

  test("does not re-fence one that is already fenced", () => {
    const fenced = "```\n" + ADDRESS + "\n```";
    expect(markCopyable(fenced, "block")).toBe(fenced);
  });

  test("keeps the rest of the sentence", () => {
    const out = markCopyable(`Wallet: ${ADDRESS} · permission active`, "block");
    expect(out).toContain("Wallet:");
    expect(out).toContain("· permission active");
    expect(out).toContain("```\n" + ADDRESS + "\n```");
  });
});

describe("telegram render", () => {
  test("a bare address becomes a <code> span — one tap copies it", () => {
    expect(render(`Your wallet address is ${ADDRESS}.`)).toBe(
      `Your wallet address is <code>${ADDRESS}</code>.`,
    );
  });

  test("still renders the rest of the markdown", () => {
    expect(render("**bold** and [a link](https://basescan.org/tx/0x1)")).toBe(
      '<b>bold</b> and <a href="https://basescan.org/tx/0x1">a link</a>',
    );
  });
});
