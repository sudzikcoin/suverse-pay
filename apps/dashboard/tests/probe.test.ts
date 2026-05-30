import { describe, expect, it, vi } from "vitest";
import { probeResourceServer } from "../src/lib/probe";
import type { ResourceServerConfig } from "../src/lib/seller-config";

const CONFIG: ResourceServerConfig = {
  resourceKeyId: "reskey_deadbeef",
  defaultPriceAtomic: "100000",
  acceptedNetworks: ["eip155:8453"],
  payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
  payToSolana: null,
  payToCosmos: null,
  payToTron: null,
  description: null,
  updatedAt: "2026-05-30T00:00:00Z",
};

function publicDnsLookup() {
  return vi.fn().mockResolvedValue([{ address: "203.0.113.10", family: 4 }]);
}

describe("probeResourceServer", () => {
  it("flags non-https schemes early", async () => {
    const result = await probeResourceServer({
      url: "ftp://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: vi.fn(),
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]?.passed).toBe(true); // url_parse
    expect(result.checks[1]?.passed).toBe(false); // url_scheme
  });

  it("blocks a hostname that resolves to a private IP", async () => {
    const dnsLookupImpl = vi
      .fn()
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const result = await probeResourceServer({
      url: "https://internal.example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: vi.fn(),
        dnsLookupImpl: dnsLookupImpl as never,
        blockPrivateIps: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "host_resolution")?.passed).toBe(
      false,
    );
  });

  it("passes a well-formed 402 challenge with matching network", async () => {
    const body = JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0xUSDC",
          payTo: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
          maxAmountRequired: "100000",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(402);
    expect(
      result.checks.find((c) => c.name === "networks_match_config")?.passed,
    ).toBe(true);
    expect(
      result.checks.find((c) => c.name === "payto_match_config")?.passed,
    ).toBe(true);
  });

  it("fails when the resource server returns 200 instead of 402", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "status_402")?.passed).toBe(
      false,
    );
  });

  it("flags content-type mismatch but keeps probing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("oops", {
        status: 402,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.checks.find((c) => c.name === "content_type")?.passed).toBe(
      false,
    );
    expect(result.ok).toBe(false);
  });

  it("fails when accepts array advertises a different network", async () => {
    const body = JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "solana:mainnet", // mismatch — config only has Base
          asset: "EPjFW…",
          payTo: "CBYM…",
          maxAmountRequired: "100000",
        },
      ],
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(
      result.checks.find((c) => c.name === "networks_match_config")?.passed,
    ).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("returns a structured timeout failure when fetch aborts", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("operation aborted"), { name: "AbortError" }));
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
        timeoutMs: 1,
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((c) => c.name === "reachable")?.passed,
    ).toBe(false);
    expect(result.checks.find((c) => c.name === "reachable")?.detail).toMatch(
      /aborted|timed out/,
    );
  });

  it("does not parse a non-JSON body even if Content-Type lies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html>oops</html>", {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await probeResourceServer({
      url: "https://example.com/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: publicDnsLookup() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.checks.find((c) => c.name === "json_parse")?.passed).toBe(
      false,
    );
  });

  it("accepts a literal public IP without DNS lookup", async () => {
    const dnsLookupImpl = vi.fn(); // should NOT be called
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: "0xUSDC",
              payTo: CONFIG.payToEvm!,
              maxAmountRequired: "100000",
            },
          ],
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await probeResourceServer({
      url: "https://203.0.113.10/paid",
      config: CONFIG,
      options: {
        fetchImpl: fetchImpl as never,
        dnsLookupImpl: dnsLookupImpl as never,
        blockPrivateIps: true,
      },
    });
    expect(dnsLookupImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("blocks literal 127.0.0.1 even with no DNS lookup", async () => {
    const result = await probeResourceServer({
      url: "https://127.0.0.1/paid",
      config: CONFIG,
      options: {
        fetchImpl: vi.fn(),
        dnsLookupImpl: vi.fn() as never,
        blockPrivateIps: true,
      },
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.find((c) => c.name === "host_resolution")?.passed,
    ).toBe(false);
  });
});
