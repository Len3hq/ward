import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadCatalog, resetCatalog, searchCatalog } from "../src/execution/catalog.ts";

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
