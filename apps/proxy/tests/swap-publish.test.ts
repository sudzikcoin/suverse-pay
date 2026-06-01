/**
 * Smoke tests for the Bazaar publish endpoints.
 *
 * Only the env gate + 402-challenge surface is exercised. We don't
 * drive a real facilitator settle — that's done by the one-shot
 * deploy script outside vitest.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  publishEnabled,
  registerSwapPublishRoutes,
} from "../src/swap-publish.js";

describe("publishEnabled", () => {
  it("only returns true for the literal 'true'", () => {
    expect(publishEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      publishEnabled({ SWAP_PUBLISH_ENABLED: "false" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      publishEnabled({ SWAP_PUBLISH_ENABLED: "1" } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      publishEnabled({ SWAP_PUBLISH_ENABLED: "true" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });
});

describe("registerSwapPublishRoutes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );
  });
  afterEach(async () => {
    await app.close();
  });

  it("does not register any route when neither signer is provided", async () => {
    registerSwapPublishRoutes(app, {
      facilitatorUrl: "https://facilitator.example",
      facilitatorApiKey: "k",
      publicBaseUrl: "https://proxy.example",
    });
    await app.ready();
    const solana = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/__publish",
    });
    expect(solana.statusCode).toBe(404);
    const base = await app.inject({
      method: "POST",
      url: "/v1/swap/base/__publish",
    });
    expect(base.statusCode).toBe(404);
  });

  it("Solana publish route returns 402 with bazaar extension when unpaid", async () => {
    registerSwapPublishRoutes(app, {
      facilitatorUrl: "https://facilitator.example",
      facilitatorApiKey: "k",
      publicBaseUrl: "https://proxy.example",
      swapSigner: {
        address: "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
        secretKey: new Uint8Array(64),
      },
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/solana/__publish",
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.accepts?.[0]?.network).toBe(
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
    expect(body.accepts?.[0]?.payTo).toBe(
      "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
    );
    expect(body.extensions?.bazaar?.info).toBeTruthy();
    expect(body.extensions?.bazaar?.info?.output?.example).toBeTypeOf(
      "object",
    );
    expect(Array.isArray(body.extensions?.bazaar?.info?.output?.example)).toBe(
      false,
    );
  });

  it("Base publish route returns 402 with bazaar extension when unpaid", async () => {
    registerSwapPublishRoutes(app, {
      facilitatorUrl: "https://facilitator.example",
      facilitatorApiKey: "k",
      publicBaseUrl: "https://proxy.example",
      baseSwapSigner: {
        address: "0x4261701A28FAA0Bc7c8D1c823bAcaa42a7Ac7BBF",
        privateKey: ("0x" + "ab".repeat(32)) as `0x${string}`,
      },
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/v1/swap/base/__publish",
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.accepts?.[0]?.network).toBe("eip155:8453");
    expect(body.extensions?.bazaar?.info).toBeTruthy();
    expect(body.extensions?.bazaar?.info?.output?.example).toBeTypeOf(
      "object",
    );
    expect(Array.isArray(body.extensions?.bazaar?.info?.output?.example)).toBe(
      false,
    );
  });
});
