import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  endpointNeedsSubject,
  loadCatalog,
  resetCatalog,
  resolveX402Call,
  searchCatalog,
  type X402Endpoint,
} from "../src/execution/catalog.ts";

beforeEach(() => resetCatalog());
afterEach(() => {
  resetCatalog();
  delete process.env.WARD_X402_CATALOG;
});

describe("catalog", () => {
  test("loads the bundled catalog", async () => {
    const endpoints = await loadCatalog();
    expect(endpoints.length).toBeGreaterThanOrEqual(3);
    expect(endpoints.every((e) => e.url && e.cost_usd >= 0)).toBe(true);
  });

  test("keyword search matches on tags and description", async () => {
    expect((await searchCatalog("is this token a rug"))?.id).toBe("token-risk");
    expect((await searchCatalog("show me whale flows"))?.id).toBe("whale-flows");
    expect((await searchCatalog("what smart money is buying"))?.id).toBe("smart-money");
  });

  test("returns null when nothing matches", async () => {
    expect(await searchCatalog("weather forecast")).toBeNull();
  });
});

describe("resolveX402Call", () => {
  const get: X402Endpoint = {
    id: "g",
    name: "G",
    description: "",
    url: "https://x.test/score?token={subject}",
    method: "GET",
    cost_usd: 0.01,
    tags: [],
  };
  const post: X402Endpoint = {
    id: "p",
    name: "P",
    description: "",
    url: "https://x.test/analyze",
    method: "POST",
    body_template: { token_address: "{subject}", chain: "base", depth: "full" },
    cost_usd: 0.02,
    tags: [],
  };

  test("GET: fills {subject} in the url, sends no body", () => {
    const call = resolveX402Call(get, "PEPE");
    expect(call).toEqual({ url: "https://x.test/score?token=PEPE", method: "GET" });
  });

  test("POST: fills string leaves of body_template, passes non-strings through", () => {
    const call = resolveX402Call(post, "0xABC");
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ token_address: "0xABC", chain: "base", depth: "full" });
  });

  test("endpointNeedsSubject reflects a placeholder in the url or the body", () => {
    expect(endpointNeedsSubject(get)).toBe(true);
    expect(endpointNeedsSubject(post)).toBe(true);
    expect(endpointNeedsSubject({ ...post, body_template: { lookback_days: 7 } })).toBe(false);
  });

  test("the bundled catalog parses method case-insensitively", async () => {
    const endpoints = await loadCatalog();
    expect(endpoints.every((e) => e.method === e.method.toUpperCase())).toBe(true);
  });
});
