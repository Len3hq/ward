/** Block-explorer link for a tx hash on the target Base network. */
export function txUrl(hash: string, network: "base" | "base-sepolia"): string {
  const host = network === "base" ? "basescan.org" : "sepolia.basescan.org";
  return `https://${host}/tx/${hash}`;
}
