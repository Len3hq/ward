/**
 * What a swap can actually be, resolved once for both spend paths.
 *
 * Ward's authority to move money is an on-chain Spend Permission, and that
 * permission is a **USDC allowance** (`memory/schema.ts`: `token: "USDC"`;
 * `cdp.ts`: `token: "usdc"`). So USDC is the only token Ward is ever authorized to
 * sell. A request to sell ETH is not a hard swap — it is one Ward has no authority
 * for at all, and the honest answer is to say so before anything is confirmed.
 *
 * It used to say the opposite. "Swap 0.0001 eth to usdc" produced a confirmation
 * prompt, and executing it would have called the CDP swap with `fromToken: ETH` and
 * an amount scaled in USDC's six decimals — 0.0001 read as 100 wei — against a
 * permission that cannot pull ETH in the first place.
 *
 * The single-token case was worse: "swap $20 into eth" parsed as the pair `ETH`,
 * which `perform.ts` split into `sell = ETH`, `buy = ETH` — a swap of a token for
 * itself, out of a wallet holding none of it.
 */

/** The only token an on-chain Spend Permission lets Ward move. */
export const SPENDABLE_SYMBOL = "USDC";

export interface SwapPair {
  sell: string;
  buy: string;
}

export type SwapPairResult = { ok: true; pair: SwapPair } | { ok: false; message: string };

/**
 * `"USDC/ETH"` → sell USDC, buy ETH. A single symbol is read as the token to buy,
 * because USDC is the only thing that can be sold.
 */
export function resolveSwapPair(raw: string | undefined): SwapPairResult {
  const symbols = (raw ?? "")
    .split("/")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);

  const [first, second] = symbols;
  if (!first) return { ok: false, message: intoWhat() };

  // One symbol: "swap $20 into ETH". USDC alone says nothing about the other side.
  if (!second) {
    if (first === SPENDABLE_SYMBOL) return { ok: false, message: intoWhat() };
    return { ok: true, pair: { sell: SPENDABLE_SYMBOL, buy: first } };
  }

  if (first === second) {
    return {
      ok: false,
      message: `That's ${first} on both sides — tell me what you want to end up holding, like "swap $10 USDC into ETH".`,
    };
  }

  if (first !== SPENDABLE_SYMBOL) {
    return {
      ok: false,
      message: [
        `I can only sell USDC. The on-chain permission you grant me is a USDC allowance, so`,
        `the ${first} in your wallet isn't something I'm authorized to move — nothing was done.`,
        ``,
        `I can go the other way: "swap $10 USDC into ${first}". To sell ${first} you'd move it yourself.`,
      ].join("\n"),
    };
  }

  return { ok: true, pair: { sell: first, buy: second } };
}

function intoWhat(): string {
  return 'Into what? Name the token you want to end up holding — for example "swap $10 USDC into ETH".';
}
