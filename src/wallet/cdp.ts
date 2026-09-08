import { createHash } from "node:crypto";

import { CdpClient, parseUnits } from "@coinbase/cdp-sdk";
import { ExactEvmScheme, toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { createPublicClient, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";

import type { CdpConfig } from "../config.ts";
import { installCdpProxy } from "../net.ts";
import type {
  Hex,
  SpendPermissionState,
  SendRequest,
  SendResult,
  SwapRequest,
  SwapResult,
  TokenBalances,
  UserWallet,
  WalletProvider,
  X402Request,
  X402Result,
} from "./provider.ts";

/**
 * Coinbase CDP wallet provider — the judged path.
 *
 * - Agent spender: one CDP Server Account (`ward-agent-spender`), shared.
 * - User wallet: a per-user CDP Smart Account (`cdpAccountName("user", …)`) owned by a
 *   per-user CDP Server Account. Hackathon-scoped managed-MPC custody — non-custodial
 *   in spirit (revocable Spend Permission), not an audited production custody stack.
 * - Spend Permission: `{ token: USDC, allowance, period: 1 day, spender }` granted
 *   from the user's smart account, revocable on-chain.
 *
 * Coinbase geoblocks some regions — `src/net.ts::installCdpProxy()` routes
 * `*.coinbase.com` through `CDP_PROXY_URL` for local dev.
 *
 * ── Verify live ───────────────────────────────────────────────────────────────
 * Field names below (`listSpendPermissions` → `.permission.spender` /
 * `.permission.allowance`, `waitForUserOperation` params, token-balance shape) are
 * taken from `@coinbase/cdp-sdk` 1.55 type declarations. Confirm against a live
 * CDP project once keys are available (see SIBYL-MEMORY.md's pattern; a
 * `wallet.cdp` opt-in test mirrors `memory.sibyl-mcp.test.ts`).
 */

const USDC_DECIMALS = 6;
const AGENT_SPENDER_NAME = "ward-agent-spender";

/** Waiting for a block is not the same as waiting for an answer — see `#settle`. */
const SETTLEMENT_BUDGET = 4;

/**
 * How long an x402 endpoint has to answer a PAID request.
 *
 * Generous, because these endpoints do real work (Heurist advertises
 * `maxTimeoutSeconds: 120`), but finite: one took 71 seconds to produce a 502 while
 * the user's turn sat waiting with their money already pulled.
 */
const X402_REQUEST_TIMEOUT_MS = 60_000;
/** A quote is a 402 challenge, not a computation — it should be quick. */
const X402_QUOTE_TIMEOUT_MS = 20_000;
/**
 * How long to wait for a USDC pull to be mined before the money is used.
 *
 * Base blocks are ~2s; this is generous because the alternative — paying against a
 * spender that is still empty — is a 402 and a refund round trip.
 */
const PULL_CONFIRM_TIMEOUT_MS = 45_000;
/** Sub-cent tolerance when comparing balances, in USD. */
const USDC_EPSILON = 1e-9;
/**
 * How hard to look for a pull before concluding the endpoint took the money.
 * ~2s Base blocks, so five tries at 1.5s covers a pull that is merely slow to mine.
 */
const UNWIND_BALANCE_ATTEMPTS = 5;
const UNWIND_BALANCE_INTERVAL_MS = 1_500;
/**
 * Fields carried BACK to the reason are the ones that might name what was wrong.
 * These are not: they are the reason itself, or x402's own scaffolding, and repeating
 * them in a chat message is noise where the point is to be specific.
 */
const NON_DIAGNOSTIC_KEYS = new Set(["error", "message", "x402Version", "accepts", "resource"]);

/**
 * Is the pulled USDC still in the spender?
 *
 * The question a failed purchase turns on, and it is answered by balances rather
 * than by an HTTP status: a 502 can come from a server that has already been paid.
 * The spender is shared, so this compares against what it held BEFORE the pull —
 * refunding on "the balance is at least the amount" would hand the user someone
 * else's float when their own payment had in fact settled.
 */
export function pullWasUnspent(heldBefore: number, heldNow: number, pulledUsd: number): boolean {
  return heldNow - heldBefore >= pulledUsd - USDC_EPSILON;
}

/**
 * Why a paid request was refused, from its own body — trimmed to one line.
 *
 * x402 puts the reason in `error`; Nansen also uses `message`. Kept short because it
 * reaches the user's chat, and wrapped in nothing: this is a server's own words about
 * a payment, so it is data, never instruction.
 */
export async function failureDetail(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  if (!raw) return "";
  let text = raw;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const reason = body.error ?? body.message;
    if (reason !== undefined && reason !== null) {
      text = typeof reason === "string" ? reason : JSON.stringify(reason);
      // Carry the OTHER fields too, when there are any. Nansen's 422 said exactly
      // "Invalid parameter" and nothing else, so which of six parameters was wrong
      // cost another paid call to work out; an endpoint that does name the field
      // usually does it in a sibling key (`detail`, `errors`, `param`). Dumping the
      // whole body when there is nothing else in it would only add noise.
      const rest = Object.fromEntries(
        Object.entries(body).filter(([key]) => !NON_DIAGNOSTIC_KEYS.has(key)),
      );
      if (Object.keys(rest).length > 0) text = `${text} · ${JSON.stringify(rest)}`;
    }
  } catch {
    // Not JSON. The raw text, trimmed, is still better than nothing.
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /abort|timeout/i.test(message)
    ? `the endpoint did not answer within ${X402_REQUEST_TIMEOUT_MS / 1000}s`
    : `the request failed (${message})`;
}

/**
 * A CDP account, as `@x402/evm` needs to see it.
 *
 * v2 duck-types far more narrowly than v1 did: `ClientEvmSigner` is `address` +
 * `signTypedData`, both of which a CDP server account already has in viem-compatible
 * shapes. The v1 path needed `toAccount()` to bolt on the `type: "local"` field
 * x402 v1 checked for, without which it threw "Invalid wallet client provided does
 * not support signTypedData" before a byte hit the network. That whole problem is
 * gone — `toClientEvmSigner` is exactly what CDP's own adapter
 * (`fromCdpEvmAccount` in `@coinbase/cdp-sdk/x402`) calls, so this is the
 * first-party path, reached without pulling in that module's Solana dependencies.
 */
export function x402Signer(account: { address: string; signTypedData: unknown }): ClientEvmSigner {
  return toClientEvmSigner(account as unknown as Parameters<typeof toClientEvmSigner>[0]);
}

/**
 * A `fetch` that restates an x402 **v1** challenge in the vocabulary the v2 scheme
 * can read.
 *
 * `@x402/evm` derives the EIP-712 chain id by parsing the network as CAIP-2, and a v1
 * server names it `"base"` — so every v1 endpoint died with "Unsupported network
 * format: base (expected eip155:CHAIN_ID)" after its USDC had been pulled. The
 * client's own `registerV1` does not help: it routes the lookup, then hands the
 * scheme the same unparseable name. Two fields differ and both are renames:
 * `network` → CAIP-2, and v1's `maxAmountRequired` → v2's `amount`.
 *
 * `x402Version` is deliberately left at 1, which is what keeps the reply correct: the
 * client picks the envelope and the header (`X-PAYMENT`, not `PAYMENT-SIGNATURE`)
 * from it. And the signed payload carries no network field of its own, so the server
 * never sees the rewritten name — verified against a local v1 server before this
 * shipped.
 */
export function modernizeV1Challenge(network: "base" | "base-sepolia"): typeof fetch {
  // Bun's `fetch` carries a `preconnect` property that a plain function does not, and
  // `wrapFetchWithPayment` only ever calls it — hence the cast rather than a stub.
  const shim = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetch(input, init);
    if (response.status !== 402) return response;

    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { x402Version?: number; accepts?: X402Offer[] } | null;
    if (body?.x402Version !== 1 || !Array.isArray(body.accepts)) return response;

    const accepts = body.accepts.map((offer) =>
      offer.network === network
        ? { ...offer, network: caip2(network), amount: offer.maxAmountRequired }
        : offer,
    );
    return new Response(JSON.stringify({ ...body, accepts }), {
      status: 402,
      headers: response.headers,
    });
  };
  return shim as unknown as typeof fetch;
}

/** CAIP-2 chain id, which is how x402 v2 names a network. v1 used the bare name. */
function caip2(network: "base" | "base-sepolia"): `${string}:${string}` {
  return network === "base" ? "eip155:8453" : "eip155:84532";
}

/**
 * One offer in a 402 challenge — what the endpoint will accept as payment.
 *
 * Two protocol versions are in the wild and the field names differ: v1 says
 * `maxAmountRequired` and names the network `"base"`, v2 says `amount` and names it
 * `"eip155:8453"`. Both are read, because Ward's catalogue holds endpoints of each
 * kind (Heurist and lucyos serve v1; Nansen is v2-only).
 */
interface X402Offer {
  scheme?: string;
  network?: string;
  asset?: string;
  /** v1. */
  maxAmountRequired?: string;
  /** v2. */
  amount?: string;
}

/**
 * The USD price an endpoint is asking, from its own 402 body — or `null` when it
 * wants something Ward cannot pay.
 *
 * Ward's authority is a USDC Spend Permission on one network, so an offer in another
 * asset or on another chain is not a cheaper option, it is an impossible one. The
 * catalogue price is only ever an estimate shown at confirmation; this is the number
 * that gets pulled from the user.
 */
export function x402QuoteUsd(
  body: unknown,
  network: "base" | "base-sepolia",
  usdcAddress: string,
): number | null {
  const offers = (body as { accepts?: X402Offer[] } | null)?.accepts ?? [];
  // A v2 endpoint lists several chains — Nansen offers Base, X Layer, BNB and
  // Solana in one challenge. Only the one Ward's Spend Permission covers is an
  // option at all; the rest are not cheaper, they are impossible.
  const accepted = new Set<string>([network, caip2(network)]);
  const amountOf = (a: X402Offer): string | undefined => a.maxAmountRequired ?? a.amount;
  const offer = offers.find(
    (a) =>
      a.scheme === "exact" &&
      a.network !== undefined &&
      accepted.has(a.network) &&
      a.asset?.toLowerCase() === usdcAddress.toLowerCase() &&
      amountOf(a) !== undefined,
  );
  if (!offer) return null;
  const price = Number(amountOf(offer)) / 10 ** USDC_DECIMALS;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/**
 * Run `work` with a deadline, and name what timed out.
 *
 * The CDP SDK sets no deadline of its own: when the service is unreachable it
 * retries internally, and one `getOrCreateAccount` was measured taking 241 seconds
 * before it gave up — a Telegram turn parked behind it for four minutes with nothing
 * in the chat to show for it. Bounded, the same failure is a clear sentence in
 * fifteen seconds.
 */
export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`CDP ${label} did not answer within ${Math.round(timeoutMs / 1000)}s`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** CDP account names: letters, digits and hyphens only, 2-36 characters. */
const CDP_NAME = /^[a-zA-Z0-9-]{2,36}$/;

/**
 * The CDP account name for one role of one account key.
 *
 * A CDP name may only contain letters, digits and hyphens and may be at most 36
 * characters, which a Ward principal violates twice over: `ward_<26-char ULID>`
 * carries an underscore, and `ward-owner-<key>` is 42 characters. Passing it
 * straight through is a 400 from `getOrCreateAccount`, which is what "connect my
 * wallet" was failing on.
 *
 * The smart-account ADDRESS is a function of this name, so what it returns for a
 * given key can never change — the same trap `ward.wallet.account_key` exists to
 * avoid. Hence the first branch: a legacy key (a bare Telegram id, which is what
 * the identity migration pinned) already produces a legal name, and must keep
 * producing exactly that one. Only keys that CDP would reject are rewritten, and
 * the ULID alone identifies the principal — the `ward_` prefix carries nothing.
 */
export function cdpAccountName(role: "owner" | "user", accountKey: string): string {
  const direct = `ward-${role}-${accountKey}`;
  if (CDP_NAME.test(direct)) return direct;

  const slug = accountKey.replace(/^ward_/, "").replace(/[^a-zA-Z0-9]/g, "");
  const short = `ward-${role[0]}-${slug}`;
  if (CDP_NAME.test(short)) return short;

  // Backstop for an account key that is neither shape: still deterministic.
  return `ward-${role[0]}-${createHash("sha256").update(accountKey).digest("hex").slice(0, 24)}`;
}

const TOKENS: Record<"base" | "base-sepolia", Record<string, Hex>> = {
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    CBETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  },
  "base-sepolia": {
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    WETH: "0x4200000000000000000000000000000000000006",
    ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  },
};

export class CdpWalletProvider implements WalletProvider {
  readonly kind = "cdp" as const;
  readonly requiresSpendPermission = true;
  #cdp: CdpClient;
  #network: "base" | "base-sepolia";
  /**
   * Gas sponsorship for the two smart-account user operations (grant / revoke).
   * Undefined → the smart account pays its own gas and must hold ETH. The
   * spender's own calls (`useSpendPermission`, `swap`, `transfer`) are plain
   * EOA transactions the SDK gives no paymaster option for, so the agent spender
   * always needs ETH regardless.
   */
  #paymasterUrl: string | undefined;
  /** See `CdpConfig.timeoutMs` — the budget for calls that submit nothing. */
  #timeoutMs: number;

  constructor(config: CdpConfig, network: "base" | "base-sepolia") {
    installCdpProxy(); // route *.coinbase.com through CDP_PROXY_URL if set
    this.#cdp = new CdpClient({
      apiKeyId: config.apiKeyId,
      apiKeySecret: config.apiKeySecret,
      walletSecret: config.walletSecret,
    });
    this.#network = network;
    this.#paymasterUrl = config.paymasterUrl;
    this.#timeoutMs = config.timeoutMs;
  }

  /**
   * A deadline for CDP calls that have not submitted a transaction.
   *
   * Only those. A timeout on a submitted transaction cannot tell "never sent" from
   * "sent and mined", and Ward must never report that nothing moved when something
   * might have — so `createSpendPermission`, `swap`, `transfer` and
   * `useSpendPermission` are deliberately left unbounded. Account lookups, permission
   * reads and balance reads are pure, retryable, and are where a hung CDP actually
   * parks a turn: every write path awaits an account lookup before it sends anything,
   * so bounding those fails fast BEFORE any money moves.
   */
  async #bounded<T>(label: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return withDeadline(label, timeoutMs ?? this.#timeoutMs, work);
  }

  /** Spread into a user-operation call; empty when no paymaster is configured. */
  get #sponsor(): { paymasterUrl?: string } {
    return this.#paymasterUrl ? { paymasterUrl: this.#paymasterUrl } : {};
  }

  #token(symbol: string): Hex {
    const address = TOKENS[this.#network][symbol.toUpperCase()];
    if (!address) throw new Error(`unknown token ${symbol} on ${this.#network}`);
    return address;
  }

  network(): "base" | "base-sepolia" {
    return this.#network;
  }

  async #agentSpender() {
    return this.#bounded("account lookup", () =>
      this.#cdp.evm.getOrCreateAccount({ name: AGENT_SPENDER_NAME }),
    );
  }

  async #userSmartAccount(accountKey: string) {
    const owner = await this.#bounded("account lookup", () =>
      this.#cdp.evm.getOrCreateAccount({ name: cdpAccountName("owner", accountKey) }),
    );
    return this.#bounded("smart-account lookup", () =>
      this.#cdp.evm.getOrCreateSmartAccount({
        name: cdpAccountName("user", accountKey),
        owner,
        enableSpendPermissions: true,
      }),
    );
  }

  async connect(accountKey: string): Promise<UserWallet> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    return { smartAccount: smart.address as Hex, agentSpender: spender.address as Hex };
  }

  async grantSpendPermission(
    accountKey: string,
    allowanceUsd: number,
    periodDays: number,
  ): Promise<SpendPermissionState> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    const op = await this.#cdp.evm.createSpendPermission({
      spendPermission: {
        account: smart.address as Hex,
        spender: spender.address as Hex,
        token: "usdc",
        allowance: parseUnits(String(allowanceUsd), USDC_DECIMALS),
        periodInDays: periodDays,
      },
      network: this.#network,
      ...this.#sponsor,
    });
    const grantedTx = await this.#settle(smart.address as Hex, op);
    const state = await this.readSpendPermission(accountKey);
    // `grantedTx` is spread over the live read, not just the fallback: the read
    // succeeds in the normal case and carries no tx of its own, so returning it
    // bare dropped the settlement hash and the chat lost its "tx 0x…" line —
    // exactly the link you need to confirm the grant landed.
    return state
      ? { ...state, grantedTx }
      : {
          status: "active",
          allowanceUsd,
          periodSeconds: Math.round(periodDays * 86_400),
          grantedTx,
        };
  }

  async readSpendPermission(accountKey: string): Promise<SpendPermissionState | null> {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    const { spendPermissions } = await this.#bounded("permission read", () =>
      this.#cdp.evm.listSpendPermissions({ address: smart.address as Hex }),
    );
    const mine = spendPermissions
      .filter((p) => p.permission.spender.toLowerCase() === String(spender.address).toLowerCase())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const latest = mine[0];
    if (!latest) return null;
    return {
      status: latest.revoked ? "revoked" : "active",
      allowanceUsd: Number(latest.permission.allowance) / 10 ** USDC_DECIMALS,
      periodSeconds: Number(latest.permission.period),
      permissionHash: latest.permissionHash,
    };
  }

  async revokeSpendPermission(accountKey: string): Promise<{ txHash: string }> {
    const smart = await this.#userSmartAccount(accountKey);
    const state = await this.readSpendPermission(accountKey);
    if (!state?.permissionHash) throw new Error("no active spend permission to revoke");
    const op = await this.#cdp.evm.revokeSpendPermission({
      address: smart.address as Hex,
      permissionHash: state.permissionHash as Hex,
      network: this.#network,
      ...this.#sponsor,
    });
    return { txHash: await this.#settle(smart.address as Hex, op) };
  }

  async usdcBalanceUsd(address: Hex): Promise<number> {
    return (await this.balances(address)).usdcUsd;
  }

  /**
   * One `listTokenBalances` call for both things a user is told: their USDC, and
   * the ETH that pays for a grant or a revocation. CDP returns native ETH in the
   * same list, under the `0xEeee…EEeE` pseudo-address — hence the symbol fallback,
   * which also covers a chain where the contract address differs.
   */
  async balances(address: Hex): Promise<TokenBalances> {
    const { balances } = await this.#bounded("balance read", () =>
      this.#cdp.evm.listTokenBalances({ address, network: this.#network }),
    );
    const held = (symbol: "USDC" | "ETH"): number => {
      const contract = this.#token(symbol).toLowerCase();
      const match = balances.find(
        (b) =>
          b.token.contractAddress.toLowerCase() === contract ||
          b.token.symbol?.toUpperCase() === symbol,
      );
      return match ? Number(match.amount.amount) / 10 ** Number(match.amount.decimals) : 0;
    };
    return { usdcUsd: held("USDC"), eth: held("ETH") };
  }

  /**
   * Buy from an x402 endpoint, paying in USDC from the user's Spend Permission.
   *
   * Three things here were wrong, and the first made every purchase impossible:
   *
   * 1. **The signer.** `wrapFetchWithPayment` accepts a viem wallet client or a viem
   *    `LocalAccount`, and decides which by duck-typing: a `LocalAccount` must carry
   *    `address`, `sign`, `signMessage`, `signTransaction`, `signTypedData` — **and a
   *    `type` field**. A CDP server account has every method but no `type`, so the
   *    cast this code used to do left x402 throwing "Invalid wallet client provided
   *    does not support signTypedData" before a single byte hit the network. Every
   *    "Buy … Confirm? yes" ended there. `toAccount()` is the documented adapter and
   *    the one CDP's own x402 guide uses; CDP's method shapes already match viem's.
   *
   * 2. **The amount.** It pulled `maxUsd` — the 1.5× cap — before knowing the price,
   *    and never returned the difference. At a real price of $0.001 against a $0.05
   *    catalogue estimate that leaves ~$0.074 of the user's money in the SHARED agent
   *    spender, and burns 75× the allowance it needed. The price is now read from the
   *    endpoint's own 402 challenge first, and exactly that is pulled.
   *
   * 3. **The cap.** `maxUsd` was enforced only inside x402's own check. A quote above
   *    what the user approved now refuses before anything is pulled, and says so.
   *
   * GET endpoints send no body; POST/PUT/PATCH send `request.body` as
   * `application/json` (the catalog's `body_template`, with `{subject}` filled).
   */
  async payX402(accountKey: string, request: X402Request): Promise<X402Result> {
    const method = request.method.toUpperCase();
    const init: RequestInit = { method };
    if (request.body !== undefined && method !== "GET" && method !== "HEAD") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(request.body);
    }

    // What does it actually charge? A 402 serves nothing and costs nothing.
    const quotedUsd = await this.#quoteX402(request.url, init);
    const priceUsd = quotedUsd ?? request.expectedUsd;
    if (priceUsd > request.maxUsd) {
      throw new Error(
        `the endpoint asks $${priceUsd} USDC, over the $${request.maxUsd} cap you approved — nothing was paid`,
      );
    }

    const spender = await this.#agentSpender();
    // Pulled AND confirmed before the endpoint is asked to be paid — see `#pullUsdc`.
    const { heldBefore: held } = await this.#pullUsdc(accountKey, priceUsd);

    // One client, both protocol versions. `register` takes a CAIP-2 network and
    // speaks v2 (Nansen is v2-only and rejects the v1 `X-PAYMENT` header);
    // `registerV1` takes the bare name v1 servers advertise (Heurist, lucyos).
    // Registering only one of them silently strands half the catalogue.
    //
    // v1's positional `maxValue` argument is gone, and nothing is lost: the cap is
    // enforced above, against the endpoint's own quote, BEFORE any USDC is pulled —
    // which is stricter than v1's check, which fired after the pull.
    const signer = x402Signer(spender);
    const network = caip2(this.#network);
    const client = new x402Client()
      .register(network, new ExactEvmScheme(signer))
      // Registered under the CAIP-2 name for v1 too, because `modernizeV1Challenge`
      // rewrites the challenge to it before the client ever looks a scheme up.
      .registerV1(network, new ExactEvmScheme(signer));
    const pay = wrapFetchWithPayment(modernizeV1Challenge(this.#network), client);

    let response: Response;
    try {
      response = await pay(request.url, {
        ...init,
        // An endpoint that never answers must not park the turn indefinitely. One
        // took 71 seconds to return a 502; aborting is safe because the balance
        // check below decides what actually happened to the money.
        signal: AbortSignal.timeout(X402_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw await this.#unwind(accountKey, priceUsd, held, describeCause(error));
    }

    if (!response.ok) {
      // Read the body before unwinding. A second 402 carries x402's own reason for
      // refusing the payment — the ONE thing that says why a signed voucher was not
      // accepted — and throwing on the status alone discarded it, leaving the failure
      // undiagnosable from the logs.
      const detail = await failureDetail(response);
      console.error(
        `x402 endpoint refused a paid request: ${response.status} ${request.url}` +
          (detail ? ` — ${detail}` : " — (no body)"),
      );
      throw await this.#unwind(
        accountKey,
        priceUsd,
        held,
        `the endpoint returned ${response.status}${detail ? ` (${detail})` : ""}`,
      );
    }

    const data: unknown = await response.json().catch(() => ({}));
    // v1 answers on `x-payment-response`, v2 on `payment-response` (Nansen lists
    // both `Payment-Response` and `Payment-Receipt` in its CORS exposure). Miss the
    // v2 name and every Nansen purchase lands in the ledger with `txHash: "0x"`.
    const paymentHeader =
      response.headers.get("x-payment-response") ?? response.headers.get("payment-response") ?? "";
    const decoded = decodePayment(paymentHeader);
    return {
      data,
      txHash: decoded.txHash ?? "0x",
      // What was authorized, not what the catalogue guessed: the ledger has to match
      // the USDC that actually left the user's wallet.
      amountUsd: decoded.amountUsd ?? priceUsd,
    };
  }

  /**
   * Pull `amountUsd` from the user's smart account into the spender, and **wait for
   * it to land**.
   *
   * The wait is the whole point. `useSpendPermission` returns as soon as the
   * transaction is SUBMITTED, and the code went straight on to make the paid
   * request — so the endpoint's facilitator tried to settle `transferWithAuthorization`
   * against a spender that was still empty, and answered `402`. It is a race, which
   * is why it looked intermittent: purchases that happened to take a few seconds
   * longer landed the pull in time and worked.
   *
   * Production, on a $0.01 purchase: pull submitted and the endpoint answered 402
   * five seconds later, with the money arriving in between.
   *
   * Returns what the spender held BEFORE the pull, which is what `#unwind` needs to
   * tell an unsettled payment from a settled one.
   */
  async #pullUsdc(accountKey: string, amountUsd: number): Promise<{ heldBefore: number }> {
    const spender = await this.#agentSpender();
    const heldBefore = await this.#spenderUsdc();
    const permission = await this.#requirePermission(accountKey);

    const result = await spender.useSpendPermission({
      spendPermission: permission,
      value: parseUnits(String(amountUsd), USDC_DECIMALS),
      network: this.#network,
    });

    const hash = (result as { transactionHash?: Hex }).transactionHash;
    if (hash) await this.#waitForPull(hash);

    // And then confirm by BALANCE, always — not only when there was no hash to wait
    // for. A receipt is not the thing callers depend on.
    //
    // The previous attempt gated this on `!hash`, reasoning that a mined receipt was
    // authoritative. It is not: `useSpendPermission` on a Server Account settles
    // through a bundle, and `waitForTransactionReceipt` resolves on that bundle
    // before the USDC inside it lands in the spender's balance. So the receipt came
    // back, the wait returned instantly, the forward fired, and it reverted with
    // `ERC20: transfer amount exceeds balance` against money that arrived moments
    // later. Measured: the whole failure took ~7s, well inside the poll budget that
    // was skipped.
    //
    // The concurrency caveat stands — the spender is shared, so another spend could
    // mask an arrival — but a false "pull did not land" refunds the user and costs a
    // retry, while a false "it landed" spends into a balance that is not there. When
    // one of two errors has to be possible, it should be the one that fails safe.
    const heldNow = await this.#spenderUsdcSettled(heldBefore, amountUsd);
    if (!pullWasUnspent(heldBefore, heldNow, amountUsd)) {
      throw new Error(
        `the $${amountUsd} USDC pull did not reach the agent wallet within ` +
          `${(UNWIND_BALANCE_ATTEMPTS * UNWIND_BALANCE_INTERVAL_MS) / 1000}s — nothing was spent`,
      );
    }
    return { heldBefore };
  }

  /** Block until the pull is mined, or say plainly that it never confirmed. */
  async #waitForPull(hash: Hex): Promise<void> {
    const client = createPublicClient({
      chain: this.#network === "base" ? base : baseSepolia,
      transport: http(),
    });
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash,
        timeout: PULL_CONFIRM_TIMEOUT_MS,
        pollingInterval: 750,
      });
    } catch {
      throw new Error(
        `the USDC transfer into the agent wallet did not confirm within ` +
          `${PULL_CONFIRM_TIMEOUT_MS / 1000}s (tx ${hash}) — nothing was paid`,
      );
    }
    if (receipt.status !== "success") {
      throw new Error(
        `the USDC transfer into the agent wallet reverted (tx ${hash}) — nothing was paid`,
      );
    }
  }

  /**
   * The agent spender's USDC, read from the CHAIN, for measuring a pull that may need
   * returning.
   *
   * `balances()` goes through CDP's `listTokenBalances`, which is an INDEXED read and
   * lags the chain by seconds. That lag decided whether a user got their money back.
   * Production: a $0.05 purchase failed 3.7s after it started, the pull had been mined
   * — the transfer is on chain, one `0xc350` into the spender — but the indexer had
   * not caught up, so the "after" balance still read the old value, the delta was
   * zero, and Ward told the user their $0.05 "had already left for the endpoint" and
   * was "NOT recoverable". Nothing had left; nothing has ever left. The refund was
   * simply never attempted.
   *
   * `balanceOf` at `latest` cannot lag what a mined transaction did.
   */
  /**
   * The spender's USDC once the pull has had a chance to land, for the refund
   * decision.
   *
   * Returns as soon as the balance reflects the pull, so the ordinary case costs one
   * read. Only a genuinely spent pull waits out the budget — and waiting a few
   * seconds to answer "is the user's money still here?" correctly is worth far more
   * than answering it instantly and wrongly.
   */
  async #spenderUsdcSettled(heldBefore: number, pulledUsd: number): Promise<number> {
    let heldNow = await this.#spenderUsdc();
    for (let attempt = 0; attempt < UNWIND_BALANCE_ATTEMPTS; attempt++) {
      if (pullWasUnspent(heldBefore, heldNow, pulledUsd)) return heldNow;
      await new Promise((resolve) => setTimeout(resolve, UNWIND_BALANCE_INTERVAL_MS));
      heldNow = await this.#spenderUsdc();
    }
    return heldNow;
  }

  async #spenderUsdc(): Promise<number> {
    const spender = await this.#agentSpender();
    return this.#usdcOnChain(spender.address as Hex);
  }

  /** `balanceOf` at `latest` — the only reading that cannot lag a mined transfer. */
  async #usdcOnChain(address: Hex): Promise<number> {
    const client = createPublicClient({
      chain: this.#network === "base" ? base : baseSepolia,
      transport: http(),
    });
    const raw = await client.readContract({
      address: this.#token("USDC"),
      abi: [
        {
          type: "function",
          name: "balanceOf",
          stateMutability: "view",
          inputs: [{ name: "account", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "balanceOf",
      args: [address],
    });
    return Number(formatUnits(raw, USDC_DECIMALS));
  }

  /**
   * Block until `amountUsd` has actually arrived at `address`.
   *
   * The same discipline the pull got, for the hop after it. A CDP `transfer` resolves
   * on SUBMIT, so `session.fund()` ran from Ward's ACP wallet while the money was
   * still in flight to it and reverted with `ERC20: transfer amount exceeds balance`
   * — the exact failure the pull fix had just eliminated one hop earlier, left in
   * place here because I fixed the transfer I was looking at rather than the pattern.
   */
  async #waitForUsdcArrival(address: Hex, heldBefore: number, amountUsd: number): Promise<void> {
    for (let attempt = 0; attempt < UNWIND_BALANCE_ATTEMPTS; attempt++) {
      if (pullWasUnspent(heldBefore, await this.#usdcOnChain(address), amountUsd)) return;
      await new Promise((resolve) => setTimeout(resolve, UNWIND_BALANCE_INTERVAL_MS));
    }
    throw new Error(
      `$${amountUsd} USDC did not arrive at ${address} within ` +
        `${(UNWIND_BALANCE_ATTEMPTS * UNWIND_BALANCE_INTERVAL_MS) / 1000}s — nothing was spent`,
    );
  }

  /**
   * A purchase that took the user's money and returned nothing.
   *
   * The pull happens before the request, so a failed request leaves USDC sitting in
   * the SHARED agent spender — the user's money, in Ward's wallet, for a thing they
   * never received. Production, exactly this: a 502 from the Whale Flows endpoint,
   * $0.001 stranded, and a message that said "Nothing was charged beyond gas."
   *
   * Whether it can be returned is a question about the chain, not about the HTTP
   * status: a 502 can come from a server that already took payment. So compare the
   * spender's USDC against what it held before the pull. Still there → the payment
   * never settled, and it goes back. Gone → the endpoint has it, and the user is
   * told that plainly rather than being refunded someone else's float.
   */
  async #unwind(
    accountKey: string,
    pulledUsd: number,
    heldBefore: number,
    reason: string,
  ): Promise<Error> {
    let outcome: string;
    try {
      // Poll, don't snapshot. A fast rejection can beat its own pull: the 422 from
      // the token screener came back in about a second while the USDC transfer took
      // ~2s to mine, so a single read showed the money "missing", no refund was
      // attempted, and it landed in the spender moments later. The endpoint failing
      // quickly must not be what decides whether the user gets their money back.
      const heldNow = await this.#spenderUsdcSettled(heldBefore, pulledUsd);
      if (pullWasUnspent(heldBefore, heldNow, pulledUsd)) {
        const { txHash } = await this.refundUser(accountKey, pulledUsd);
        outcome = `your $${pulledUsd} USDC was returned to your wallet (tx ${txHash}).`;
      } else {
        // Say what is known, not the worst reading of it. "You paid for a response
        // that failed" was said about money that had never moved, and a user told
        // that has no reason to go looking. The balance not showing the pull does
        // NOT prove the endpoint took it — the spender is shared, so a concurrent
        // spend explains the same reading.
        console.error(
          `x402 unwind: spender USDC ${heldNow} vs ${heldBefore} before a $${pulledUsd} pull — ` +
            "not refunding automatically; check the spender against the chain",
        );
        outcome =
          `$${pulledUsd} USDC is not back in your wallet, and I can't tell from here whether ` +
          `the endpoint took it or it is still held by the agent spender — so I have not ` +
          `refunded it automatically. Nothing further will happen on its own.`;
      }
    } catch (error) {
      outcome =
        `$${pulledUsd} USDC was pulled and I could not return it ` +
        `(${error instanceof Error ? error.message : String(error)}). It is held by the agent spender.`;
    }
    // Marked so `execution/perform.ts` does not append its blanket "Nothing was
    // charged beyond gas" to a message that has just explained where the money went.
    return Object.assign(new Error(`${reason} — ${outcome}`), { moneyAccounted: true });
  }

  /**
   * The endpoint's own price, in USD, from an unpaid request — or `null` if it did
   * not answer with a usable 402 (then the catalogue estimate stands, still capped).
   *
   * Only USDC on Ward's network counts: the Spend Permission is a USDC allowance, so
   * an endpoint wanting anything else is one Ward cannot pay by any route.
   */
  async #quoteX402(url: string, init: RequestInit): Promise<number | null> {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(X402_QUOTE_TIMEOUT_MS),
      });
      if (response.status !== 402) return null;
      return x402QuoteUsd(await response.json(), this.#network, this.#token("USDC"));
    } catch {
      // A quote is an optimisation, never a gate: fall back to the catalogue price,
      // which x402's own `maxValue` still caps.
      return null;
    }
  }

  /**
   * VERIFY LIVE. Pull `amountUsd` USDC within the Spend Permission, then swap it on
   * Base via the CDP swap API. Testnet DEX liquidity is thin — the plan's fallback
   * is a WETH wrap/unwrap presented honestly as the swap primitive.
   */
  async swap(accountKey: string, request: SwapRequest): Promise<SwapResult> {
    const [spender, smart] = await Promise.all([
      this.#agentSpender(),
      this.#userSmartAccount(accountKey),
    ]);
    const fromAmount = parseUnits(String(request.amountUsd), USDC_DECIMALS);
    const { heldBefore } = await this.#pullUsdc(accountKey, request.amountUsd);

    // Measure around the swap. `spender.swap()` returns a transaction hash and
    // nothing about the output, so the delta in the spender's balance is the only
    // way to know how much arrived — and it has to be known, because the proceeds
    // belong to the user, not to the agent that executed for them.
    const spenderAddress = spender.address as Hex;
    const before = await this.#rawBalance(spenderAddress, request.buySymbol);
    let result;
    try {
      result = await spender.swap({
        network: this.#network,
        fromToken: this.#token(request.sellSymbol),
        toToken: this.#token(request.buySymbol),
        fromAmount,
        slippageBps: 150,
      });
    } catch (error) {
      // Same rule as a failed purchase: the USDC was pulled before the swap, so a
      // swap that never happened must not leave it in the shared spender.
      throw await this.#unwind(
        accountKey,
        request.amountUsd,
        heldBefore,
        `the swap failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    const txHash =
      (result as { transactionHash?: string }).transactionHash ??
      (result as { userOpHash?: string }).userOpHash ??
      "0x";

    const after = await this.#rawBalance(spenderAddress, request.buySymbol);
    const received = after.amount > before.amount ? after.amount - before.amount : 0n;

    let sweepTx: string | undefined;
    let buyDisplay = `swapped into ${request.buySymbol.toUpperCase()}`;
    if (received > 0n) {
      const display = formatUnits(received, after.decimals);
      buyDisplay = `${display} ${request.buySymbol.toUpperCase()}`;
      // Only the delta moves, so the spender keeps the ETH it needs for gas — which
      // matters most when the bought token IS native ETH.
      const transfer = await spender.transfer({
        to: smart.address as Hex,
        amount: received,
        token: this.#transferToken(request.buySymbol),
        network: this.#network,
      });
      sweepTx = (transfer as { transactionHash?: string }).transactionHash;
    }

    return { txHash, sellUsd: request.amountUsd, buyDisplay, sweepTx };
  }

  /**
   * Move USDC from the user's smart account to any address, within the Spend
   * Permission: pull to the spender, then forward. Two transactions, and the pull is
   * a hard error rather than a soft skip — sending Ward's own float because a
   * permission was missing would be the worst possible failure here.
   */
  async sendUsdc(accountKey: string, request: SendRequest): Promise<SendResult> {
    const heldBefore = await this.#spenderUsdc();
    await this.fundAgentFromUser(accountKey, request.amountUsd);
    try {
      const { txHash } = await this.transferUsdcFromSpender(request.to, request.amountUsd);
      return { txHash, amountUsd: request.amountUsd };
    } catch (error) {
      // The pull landed and the forward did not: the money is in the spender, not
      // with the recipient. Put it back rather than leaving it in Ward's wallet.
      throw await this.#unwind(
        accountKey,
        request.amountUsd,
        heldBefore,
        `the transfer failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  /**
   * The permission every spend pulls against, or a refusal.
   *
   * `swap` and `payX402` used to treat a missing permission as "skip the pull and
   * carry on", which spends the SHARED agent spender's own USDC — Ward's float, on
   * behalf of a user who granted nothing, with the proceeds swept to them. Fail
   * closed instead, the way `fundAgentFromUser` always did.
   */
  async #requirePermission(accountKey: string) {
    const permission = await this.#rawPermission(accountKey);
    if (!permission) {
      throw new Error("no active Spend Permission — grant one before Ward can spend your USDC");
    }
    return permission;
  }

  /** Raw balance of one symbol, for measuring a swap's output. */
  async #rawBalance(address: Hex, symbol: string): Promise<{ amount: bigint; decimals: number }> {
    const wanted = this.#token(symbol).toLowerCase();
    const upper = symbol.toUpperCase();
    const { balances } = await this.#bounded("balance read", () =>
      this.#cdp.evm.listTokenBalances({ address, network: this.#network }),
    );
    const match = balances.find(
      (b) =>
        b.token.contractAddress.toLowerCase() === wanted || b.token.symbol?.toUpperCase() === upper,
    );
    if (!match) return { amount: 0n, decimals: upper === "USDC" ? USDC_DECIMALS : 18 };
    return { amount: BigInt(match.amount.amount), decimals: Number(match.amount.decimals) };
  }

  /** `transfer` takes a symbol for the two it knows, and a contract address otherwise. */
  #transferToken(symbol: string): "eth" | "usdc" | Hex {
    const upper = symbol.toUpperCase();
    if (upper === "ETH") return "eth";
    if (upper === "USDC") return "usdc";
    return this.#token(symbol);
  }

  /**
   * VERIFY LIVE. Pull `amountUsd` USDC from the user's smart account into the agent
   * spender, within the Spend Permission — the same `useSpendPermission` primitive
   * `swap` and `payX402` use.
   *
   * ACP escrow is funded from the spender's own balance (the buyer address the CDP
   * adapter exposes), so without this pull an ACP job would spend Ward's float
   * while the ledger recorded it as the user's spend. A missing permission is a
   * hard error here, not the soft skip the near-atomic swap/x402 paths take.
   */
  async fundAgentFromUser(accountKey: string, amountUsd: number): Promise<{ pulledUsd: number }> {
    // Same wait as every other pull: whatever spends this next needs the money to be
    // there, not merely on its way.
    await this.#pullUsdc(accountKey, amountUsd);
    return { pulledUsd: amountUsd };
  }

  /** VERIFY LIVE. Send USDC from the agent spender to any address. */
  async transferUsdcFromSpender(to: Hex, amountUsd: number): Promise<{ txHash: string }> {
    const spender = await this.#agentSpender();
    // What the destination held first, so arrival is measurable rather than assumed.
    const heldBefore = await this.#usdcOnChain(to);
    const result = await spender.transfer({
      to,
      amount: parseUnits(String(amountUsd), USDC_DECIMALS),
      token: "usdc",
      network: this.#network,
    });
    // `transfer` resolves on SUBMIT. Every caller then immediately spends what it
    // just sent — ACP funds escrow from the destination, `send` reports a completed
    // transfer, `refundUser` tells the user their money is back — and all three were
    // saying so while the transfer was still in flight.
    await this.#waitForUsdcArrival(to, heldBefore, amountUsd);
    return { txHash: (result as { transactionHash?: string }).transactionHash ?? "0x" };
  }

  /** VERIFY LIVE. Send unspent USDC back from the agent spender to the user's smart account. */
  async refundUser(accountKey: string, amountUsd: number): Promise<{ txHash: string }> {
    const smart = await this.#userSmartAccount(accountKey);
    return this.transferUsdcFromSpender(smart.address as Hex, amountUsd);
  }

  /** The full on-chain SpendPermission struct, needed by `useSpendPermission`. */
  async #rawPermission(accountKey: string) {
    const [smart, spender] = await Promise.all([
      this.#userSmartAccount(accountKey),
      this.#agentSpender(),
    ]);
    const { spendPermissions } = await this.#bounded("permission read", () =>
      this.#cdp.evm.listSpendPermissions({ address: smart.address as Hex }),
    );
    const match = spendPermissions
      .filter(
        (p) =>
          !p.revoked &&
          p.permission.spender.toLowerCase() === String(spender.address).toLowerCase(),
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return match?.permission ?? null;
  }

  async #settle(
    smartAccountAddress: Hex,
    op: { userOpHash: string; transactionHash?: string },
  ): Promise<string> {
    if (op.transactionHash) return op.transactionHash;
    try {
      // Bounded generously: this waits for a block, and a slow chain is not an error.
      // Timing out here is safe in a way it is not elsewhere — the catch below falls
      // back to the userOp hash, so the operation is still reported, never denied.
      const done = await this.#bounded(
        "settlement",
        () =>
          this.#cdp.evm.waitForUserOperation({
            smartAccountAddress,
            userOpHash: op.userOpHash as Hex,
          }),
        this.#timeoutMs * SETTLEMENT_BUDGET,
      );
      return (done as { transactionHash?: string }).transactionHash ?? op.userOpHash;
    } catch {
      return op.userOpHash;
    }
  }
}

/** Settlement tx hash + settled amount from an x402 `X-Payment-Response` header (base64 JSON). */
function decodePayment(header: string): { txHash?: string; amountUsd?: number } {
  if (!header) return {};
  try {
    const d = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      transaction?: string;
      txHash?: string;
      amount?: string | number;
      value?: string | number;
    };
    const txHash = typeof d.transaction === "string" ? d.transaction : d.txHash;
    const raw = d.amount ?? d.value;
    const amountUsd = raw !== undefined ? Number(raw) / 10 ** USDC_DECIMALS : undefined;
    return {
      txHash: typeof txHash === "string" ? txHash : undefined,
      amountUsd: amountUsd !== undefined && Number.isFinite(amountUsd) ? amountUsd : undefined,
    };
  } catch {
    return {};
  }
}
