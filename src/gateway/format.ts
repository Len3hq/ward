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

/** A 20-byte EVM address. Tx hashes are left alone: they are for tapping, not copying. */
const ADDRESS_SOURCE = String.raw`0x[a-fA-F0-9]{40}`;
const ADDRESS = new RegExp(String.raw`\b${ADDRESS_SOURCE}\b`, "g");

/** Regions to step over: fenced code, inline code, and the whole of a markdown link. */
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;
/** Block style re-does inline code, so only fenced blocks and links stay off-limits. */
const FENCED_OR_LINK = /```[\s\S]*?```|\[[^\]\n]*\]\([^)\n]*\)/g;

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
