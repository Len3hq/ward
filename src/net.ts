import { loadConfig } from "./config.ts";

/**
 * Coinbase / CDP geoblock workaround.
 *
 * Coinbase's API (`api.cdp.coinbase.com`, the x402 facilitator, wallet ops)
 * geoblocks some regions. `installCdpProxy()` patches `globalThis.fetch` so that
 * **only** `*.coinbase.com` requests go through `CDP_PROXY_URL` (Bun's per-request
 * `proxy` option) — OpenAI, Telegram, Sibyl Memory and x402 endpoints are left
 * alone.
 *
 * A deploy in a non-blocked region (e.g. Railway) leaves `CDP_PROXY_URL` unset and
 * this is a no-op. The blunt alternative — routing everything — is the standard
 * `HTTPS_PROXY` env var, which Bun's fetch honours natively.
 */

let installed = false;

export function installCdpProxy(): void {
  if (installed) return;
  installed = true;

  const proxy = loadConfig().cdpProxyUrl;
  if (!proxy) return;

  const original = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (isCoinbaseHost(input)) {
      return original(input, { ...init, proxy } as RequestInit);
    }
    return original(input, init);
  }) as typeof fetch;

  console.log(`CDP proxy active for *.coinbase.com via ${redact(proxy)}`);
}

/** Explicit proxied fetch, for code that wants to opt in without the global patch. */
export function cdpFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const proxy = loadConfig().cdpProxyUrl;
  return proxy ? fetch(input, { ...init, proxy } as RequestInit) : fetch(input, init);
}

export function isCoinbaseHost(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    return /(^|\.)coinbase\.com$/i.test(new URL(href).hostname);
  } catch {
    return false;
  }
}

function redact(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "(set)";
  }
}
