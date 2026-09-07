/**
 * Making an address copyable, per channel.
 *
 * A wallet address is useless if it can't leave the chat: people fund it from an
 * exchange, paste it into a block explorer, send it to someone. Selecting 42
 * characters by hand on a phone is exactly where that goes wrong, and a
 * mis-transcribed address loses money.
 *
 * No channel offers a "copy button" primitive, so each one's own copyable text is
 * used instead — which is why the style is a parameter and the call site is the
 * adapter:
 *
 *   Telegram  `<code>` — one tap copies it, with a confirmation toast
 *   Discord   a fenced code block — the copy button on desktop, long-press on mobile
 *
 * This runs over FINISHED text, not over the nodes that produce it, because the
 * model writes addresses too — and the model, unlike a node, cannot be relied on to
 * mark them up. Fenced blocks and markdown links are left exactly as they are.
 */

export type CopyStyle = "inline" | "block";

/**
 * A 20-byte EVM address, and nothing that merely starts like one.
 *
 * The lookarounds are load-bearing. Without the trailing one, the first 40 hex
 * characters of a 64-character TRANSACTION hash match — which is exactly what
 * happened to a settlement link in production:
 *
 *   Paid $0.001 for "Smart Money Positioning". https://basescan.org/tx/
 *   ```
 *   0x32271c07ce577c598c8ce1d7a4084317276a082b
 *   ```
 *   57f779053e039342621414d6
 *
 * A link cut in half, a hash in two pieces, neither of them clickable or copyable.
 * Tx hashes are deliberately left whole: they are for tapping, not copying.
 */
const ADDRESS_SOURCE = String.raw`(?<![\w])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])`;
const ADDRESS = new RegExp(ADDRESS_SOURCE, "g");

/** A bare URL. Reformatting anything inside one breaks it — see above. */
const URL_SOURCE = String.raw`https?:\/\/\S+`;

/** Regions to step over: fenced code, inline code, markdown links, and bare URLs. */
const PROTECTED = new RegExp(
  String.raw`\`\`\`[\s\S]*?\`\`\`|\`[^\`\n]*\`|\[[^\]\n]*\]\([^)\n]*\)|${URL_SOURCE}`,
  "g",
);
/** Block style re-does inline code, so only fences, links and URLs stay off-limits. */
const FENCED_OR_LINK = new RegExp(
  String.raw`\`\`\`[\s\S]*?\`\`\`|\[[^\]\n]*\]\([^)\n]*\)|${URL_SOURCE}`,
  "g",
);

export function markCopyable(text: string, style: CopyStyle): string {
  if (style === "inline") return outside(text, PROTECTED, inlineCode);
  // An address already written as inline code (a node's own backticks) still has to
  // become a block here, or Discord shows it monospaced with nothing to click.
  const bared = outside(text, FENCED_OR_LINK, (segment) =>
    segment.replace(new RegExp(String.raw`\`(${ADDRESS_SOURCE})\``, "g"), "$1"),
  );
  return outside(bared, FENCED_OR_LINK, codeBlock).replace(/\n{3,}/g, "\n\n");
}

/** Apply `transform` to everything `protectedRegions` does not cover. */
function outside(
  text: string,
  protectedRegions: RegExp,
  transform: (segment: string) => string,
): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(protectedRegions)) {
    out += transform(text.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return out + transform(text.slice(cursor));
}

function inlineCode(segment: string): string {
  return segment.replace(ADDRESS, "`$&`");
}

function codeBlock(segment: string): string {
  // A block breaks the line anyway, so the sentence's own trailing punctuation is
  // dropped rather than left stranded on a line of its own under the address.
  return segment.replace(
    new RegExp(String.raw`[ \t]*(${ADDRESS_SOURCE})[.,;:]?[ \t]*`, "g"),
    (_m, address: string) => `\n\`\`\`\n${address}\n\`\`\`\n`,
  );
}
