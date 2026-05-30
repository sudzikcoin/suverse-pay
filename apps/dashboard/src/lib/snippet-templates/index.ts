/**
 * Snippet generator entry point. The /api/keys/[id]/snippet route
 * resolves the seller's config + their key id, builds a
 * `TemplateInput`, and asks the framework-specific renderer to
 * produce a `RenderedSnippet`.
 *
 * The renderers are pure — no DB, no fetch — so they're cheap to
 * unit-test against snapshot fixtures.
 */

import { lookupNetwork } from "../networks-catalog";
import type { ResourceServerConfig } from "../seller-config";
import { renderExpress } from "./express";
import { renderFastify } from "./fastify";
import { renderFastAPI } from "./fastapi";
import type {
  AcceptedPaymentForSnippet,
  Framework,
  RenderedSnippet,
  TemplateInput,
} from "./types";

const RENDERERS: Record<
  Framework,
  (input: TemplateInput) => RenderedSnippet
> = {
  express: renderExpress,
  fastify: renderFastify,
  fastapi: renderFastAPI,
};

export const SUPPORTED_FRAMEWORKS: readonly Framework[] = [
  "express",
  "fastify",
  "fastapi",
];

/**
 * Pulls the network label + asset address out of the catalog so the
 * renderers don't need their own copy. If a CAIP-2 id in the config
 * isn't in the catalog (shouldn't happen — Zod blocks it), fall back
 * to the id itself for label and empty string for asset (snippet
 * will compile-error visibly, telling the seller something is off).
 */
function buildAcceptedPayments(
  config: ResourceServerConfig,
): AcceptedPaymentForSnippet[] {
  const items: AcceptedPaymentForSnippet[] = [];
  for (const network of config.acceptedNetworks) {
    const entry = lookupNetwork(network);
    if (!entry) continue;
    const payTo = payToFor(entry.namespace, config);
    if (!payTo) continue;
    items.push({
      scheme: "exact",
      network,
      asset: entry.usdcAsset,
      payTo,
      maxAmountRequired: config.defaultPriceAtomic,
      networkLabel: entry.label,
    });
  }
  return items;
}

function payToFor(
  namespace: "evm" | "solana" | "cosmos" | "tron",
  config: ResourceServerConfig,
): string | null {
  switch (namespace) {
    case "evm":
      return config.payToEvm;
    case "solana":
      return config.payToSolana;
    case "cosmos":
      return config.payToCosmos;
    case "tron":
      return config.payToTron;
  }
}

export interface RenderArgs {
  readonly framework: Framework;
  readonly keyId: string;
  readonly facilitatorUrl: string;
  readonly config: ResourceServerConfig;
  readonly timestamp?: string;
}

export function renderSnippet(args: RenderArgs): RenderedSnippet {
  const payments = buildAcceptedPayments(args.config);
  const input: TemplateInput = {
    keyId: args.keyId,
    facilitatorUrl: args.facilitatorUrl,
    acceptedPayments: payments,
    description: args.config.description,
    timestamp: args.timestamp ?? new Date().toISOString().slice(0, 10),
  };
  return RENDERERS[args.framework](input);
}

export function isFramework(value: string): value is Framework {
  return (SUPPORTED_FRAMEWORKS as readonly string[]).includes(value);
}

export type { Framework, RenderedSnippet, TemplateInput } from "./types";
