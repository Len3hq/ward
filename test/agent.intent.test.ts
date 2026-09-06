import { describe, expect, test } from "bun:test";

import { describeIntent, tableIntent } from "../src/agent/intent.ts";

describe("tableIntent", () => {
  test("parses a swap with amount and pair", () => {
    expect(tableIntent("swap $50 usdc for eth")).toMatchObject({
      action_type: "swap",
      amount_usd: 50,
      pair: "USDC/ETH",
    });
    expect(tableIntent("trade 25 USDC into WETH")).toMatchObject({
      action_type: "swap",
      amount_usd: 25,
      pair: "USDC/WETH",
    });
  });

  test("recognises wallet / permission / revoke actions", () => {
    expect(tableIntent("generate my wallet")?.action_type).toBe("generate_wallet");
    // "connect" is still accepted — it is what earlier builds and DEMO.md taught.
    expect(tableIntent("connect my wallet")?.action_type).toBe("generate_wallet");
    expect(tableIntent("create a wallet for me")?.action_type).toBe("generate_wallet");
    expect(tableIntent("grant a $100 spend permission")).toMatchObject({
      action_type: "grant_permission",
      amount_usd: 100,
    });
    expect(tableIntent("revoke swaps for now")?.action_type).toBe("revoke");
    expect(tableIntent("pause trading")?.action_type).toBe("revoke");
  });

  test("routes data questions to x402 and explicit hiring to acp_job", () => {
    expect(tableIntent("is PEPE a rug")?.action_type).toBe("x402_data_purchase");
    expect(tableIntent("get me a risk score on this token")?.action_type).toBe(
      "x402_data_purchase",
    );
    expect(tableIntent("show me whale activity on ETH")?.action_type).toBe("x402_data_purchase");
    expect(tableIntent("hire an agent to assess PEPE")?.action_type).toBe("acp_job");
  });

  test("classifies questions as read_only", () => {
    expect(tableIntent("what are my limits")?.action_type).toBe("read_only");
    expect(tableIntent("how much have I spent today")?.action_type).toBe("read_only");
  });

  test("returns null when ambiguous (defers to the LLM)", () => {
    expect(tableIntent("hey")).toBeNull();
    expect(tableIntent("thanks, that's helpful")).toBeNull();
  });
});

describe("describeIntent", () => {
  test("renders a swap for the confirmation prompt", () => {
    expect(
      describeIntent({ action_type: "swap", amount_usd: 50, pair: "USDC/ETH", source: "table" }),
    ).toBe("Swap $50 USDC → ETH");
  });
});
