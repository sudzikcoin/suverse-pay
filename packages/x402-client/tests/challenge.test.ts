import { describe, expect, it } from "vitest";
import {
  parseChallenge,
  parseChallengeHeader,
} from "../src/network/challenge.js";

describe("parseChallenge — v2 shape", () => {
  it("parses a Coinbase-flavour v2 body", () => {
    const body = {
      x402Version: 2,
      resource: {
        url: "https://api.example/paid",
        description: "test",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xUSDC",
          payTo: "0xMerchant",
          amount: "100000",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    };
    const parsed = parseChallenge(body, "https://api.example/paid");
    expect(parsed.x402Version).toBe(2);
    expect(parsed.resource.url).toBe("https://api.example/paid");
    expect(parsed.resource.description).toBe("test");
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0]?.amount).toBe("100000");
    expect(parsed.accepts[0]?.extra?.name).toBe("USD Coin");
  });
});

describe("parseChallenge — v1 legacy shape", () => {
  it("normalises maxAmountRequired → amount and missing maxTimeoutSeconds → 60", () => {
    const body = {
      x402Version: 1,
      paymentRequirements: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xUSDC",
          payTo: "0xMerchant",
          maxAmountRequired: "70000",
        },
      ],
    };
    const parsed = parseChallenge(body, "https://api.example/paid");
    expect(parsed.x402Version).toBe(1);
    expect(parsed.accepts[0]?.amount).toBe("70000");
    expect(parsed.accepts[0]?.maxTimeoutSeconds).toBe(60);
  });

  it("falls back resource.url to the request URL when v1 omits it", () => {
    const body = {
      x402Version: 1,
      paymentRequirements: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xUSDC",
          payTo: "0xMerchant",
          maxAmountRequired: "70000",
        },
      ],
    };
    const parsed = parseChallenge(body, "https://api.example/paid");
    expect(parsed.resource.url).toBe("https://api.example/paid");
  });
});

describe("parseChallenge — error paths", () => {
  it("rejects an empty accepts array", () => {
    expect(() =>
      parseChallenge({ x402Version: 2, accepts: [] }, "https://x"),
    ).toThrow(/non-empty/);
  });

  it("rejects a missing 'accepts' field", () => {
    expect(() => parseChallenge({ x402Version: 2 }, "https://x")).toThrow(
      /accepts/,
    );
  });

  it("rejects a non-object body", () => {
    expect(() => parseChallenge("not an object", "https://x")).toThrow(
      /JSON object/,
    );
  });

  it("rejects an accept without scheme", () => {
    expect(() =>
      parseChallenge(
        {
          x402Version: 2,
          accepts: [
            {
              network: "eip155:8453",
              asset: "0xUSDC",
              payTo: "0xa",
              amount: "1",
            },
          ],
        },
        "https://x",
      ),
    ).toThrow(/scheme/);
  });
});

describe("parseChallengeHeader", () => {
  it("decodes base64 JSON and reuses parseChallenge", () => {
    const body = {
      x402Version: 2,
      resource: { url: "https://api.example/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xUSDC",
          payTo: "0xMerchant",
          amount: "70000",
          maxTimeoutSeconds: 60,
        },
      ],
    };
    const header = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
    const parsed = parseChallengeHeader(header, "https://x");
    expect(parsed.accepts[0]?.amount).toBe("70000");
  });

  it("rejects invalid base64", () => {
    expect(() => parseChallengeHeader("!!!not-base64", "https://x")).toThrow(
      /JSON/,
    );
  });
});
