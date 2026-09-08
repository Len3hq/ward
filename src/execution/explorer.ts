export type BaseNetwork = "base" | "base-sepolia";

const HOST: Record<BaseNetwork, string> = {
  base: "basescan.org",
  "base-sepolia": "sepolia.basescan.org",
};

/**
 * A hash Basescan could actually resolve.
 *
 * The settlement paths all fall back to the placeholder `"0x"` when they cannot read
 * a hash — x402 when the facilitator omits the `X-Payment-Response` header, ACP when
 * escrow settles inside the SDK. That placeholder used to be pasted straight into a
 * URL, so a receipt could end in `https://basescan.org/tx/0x`: a dead link, printed
 * with the same confidence as a real one, on the message that tells someone their
 * money moved. Anything that is not 32 bytes of hex is not a transaction.
 */
export function isTxHash(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash);
}

/** Block-explorer link for a tx hash on the target Base network. */
export function txUrl(hash: string, network: BaseNetwork): string {
  return `https://${HOST[network]}/tx/${hash}`;
}

/** Block-explorer link for an address on the target Base network. */
export function addressUrl(address: string, network: BaseNetwork): string {
  return `https://${HOST[network]}/address/${address}`;
}

/**
 * The link a receipt ends with — a labelled link, or nothing at all.
 *
 * A markdown link rather than a bare URL, because a 66-character hash pasted into a
 * chat message is not information anyone reads. It wraps across lines on a phone,
 * pushes the sentence that matters off the screen, and says nothing a label would not
 * say better. What a person wants from a receipt is one tappable word.
 *
 * Returns an empty string rather than a broken link when there is no usable hash,
 * because the alternative that was shipped is worse than saying nothing: a user who
 * taps through to an empty Basescan page has been told their transaction never
 * happened. Callers join with `.filter(Boolean)`, so an absent link leaves no gap.
 *
 * Both channels render this: Discord natively, Telegram through `mdToHtml`.
 */
export function txLink(
  hash: string | null | undefined,
  network: BaseNetwork,
  label = "View on Basescan",
): string {
  if (!isTxHash(hash)) return "";
  return `[${label}](${txUrl(hash, network)})`;
}
