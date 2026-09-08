/**
 * Swap and USDC transfer ("send") are switched off.
 *
 * The on-chain execution paths for both are not reliable yet, so Ward does not offer
 * them: no user-facing copy mentions them, `/start` and `/help` don't list them, and
 * a request for one is met with a specific, neutral decline (`nodes/refuse.ts`)
 * rather than a confirmation. An MCP client cannot be granted either action.
 *
 * The phrasings are still *recognised* by the intent parser — that is deliberate, so
 * the decline is specific rather than a confused conversational reply — they just
 * never reach `confirm`. The execution code in `execution/perform.ts` and the
 * `swap` / `send` branches of `nodes/confirm.ts` are intact and still covered by
 * `test/execution.send-swap.test.ts`.
 *
 * To re-enable: default this to `true` (or set `WARD_TRANSFERS_ENABLED=1`). Read as a
 * function, not a constant, so a test can flip the env var per-run — `hermeticSetup`
 * turns it on so the gate / cap / revocation suites can keep using a swap as their
 * variable-amount spend.
 */
export function transfersEnabled(): boolean {
  return process.env.WARD_TRANSFERS_ENABLED === "1";
}
