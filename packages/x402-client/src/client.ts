/**
 * `SuverseClient` — fetch-style high-level API. In v0.1.0 only the
 * EVM signing path is implemented end-to-end; Solana/Cosmos/TRON
 * land in later phases. The selection + parsing layers ARE already
 * multi-VM aware, so wiring the remaining signers in subsequent
 * phases requires no change to `.fetch()`.
 */

import { EvmSigner, toHeaderValue } from "./signers/evm.js";
import { SolanaSigner } from "./signers/solana.js";
import { CosmosSigner } from "./signers/cosmos.js";
import {
  TronSigner,
  type GasfreeDomain,
} from "./signers/tron.js";
import { parseChallenge, parseChallengeHeader } from "./network/challenge.js";
import { selectRequirement } from "./network/routing.js";
import { DEFAULT_FACILITATOR_URL } from "./facilitator/suverse.js";
import {
  X402ClientError,
  type AcceptedRequirement,
  type ChallengeBody,
  type FetchResult,
  type MultiChainWallets,
  type PaymentEnvelope,
  type PaymentReceipt,
  type Preferences,
} from "./types.js";

export interface SuverseClientOptions {
  readonly wallets: MultiChainWallets;
  /**
   * Default facilitator URL surfaced in error messages. Does NOT
   * change which facilitator actually settles — that's whatever the
   * seller's resource server points at in the 402 challenge.
   * Default: `https://facilitator.suverse.io`.
   */
  readonly defaultFacilitator?: string;
  readonly preferences?: Preferences;
  /**
   * Optional fetch implementation injection (for tests + custom TLS).
   * Defaults to the global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Per-VM signer overrides. Use these to pass an explicit RPC
   * endpoint for Solana blockhash fetching, or a custom signer
   * subclass. Optional.
   */
  readonly signerOptions?: {
    readonly solana?: {
      readonly rpcEndpoint?: string;
      readonly computeUnitPriceMicroLamports?: number;
      readonly computeUnitLimit?: number;
    };
    readonly cosmos?: {
      readonly validitySeconds?: number;
    };
    readonly tron?: {
      readonly gasfreeDomain?: {
        readonly mainnet?: GasfreeDomain;
        readonly nile?: GasfreeDomain;
      };
      readonly validitySeconds?: number;
      readonly defaultMaxFeeAtomic?: bigint;
    };
  };
}

export class SuverseClient {
  private readonly wallets: MultiChainWallets;
  private readonly preferences: Preferences;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultFacilitator: string;
  private readonly evm: EvmSigner | null;
  private readonly solana: SolanaSigner | null;
  private readonly cosmos: CosmosSigner | null;
  private readonly tron: TronSigner | null;

  constructor(options: SuverseClientOptions) {
    this.wallets = options.wallets;
    this.preferences = options.preferences ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultFacilitator =
      options.defaultFacilitator ?? DEFAULT_FACILITATOR_URL;
    this.evm =
      options.wallets.evm !== undefined
        ? new EvmSigner({ wallet: options.wallets.evm })
        : null;
    const solanaOpts = options.signerOptions?.solana ?? {};
    this.solana =
      options.wallets.solana !== undefined
        ? new SolanaSigner({
            wallet: options.wallets.solana,
            ...(solanaOpts.rpcEndpoint !== undefined
              ? { rpcEndpoint: solanaOpts.rpcEndpoint }
              : {}),
            ...(solanaOpts.computeUnitPriceMicroLamports !== undefined
              ? {
                  computeUnitPriceMicroLamports:
                    solanaOpts.computeUnitPriceMicroLamports,
                }
              : {}),
            ...(solanaOpts.computeUnitLimit !== undefined
              ? { computeUnitLimit: solanaOpts.computeUnitLimit }
              : {}),
          })
        : null;
    const cosmosOpts = options.signerOptions?.cosmos ?? {};
    this.cosmos =
      options.wallets.cosmos !== undefined
        ? new CosmosSigner({
            wallet: options.wallets.cosmos,
            ...(cosmosOpts.validitySeconds !== undefined
              ? { validitySeconds: cosmosOpts.validitySeconds }
              : {}),
          })
        : null;
    const tronOpts = options.signerOptions?.tron ?? {};
    this.tron =
      options.wallets.tron !== undefined
        ? new TronSigner({
            wallet: options.wallets.tron,
            ...(tronOpts.gasfreeDomain !== undefined
              ? { gasfreeDomain: tronOpts.gasfreeDomain }
              : {}),
            ...(tronOpts.validitySeconds !== undefined
              ? { validitySeconds: tronOpts.validitySeconds }
              : {}),
            ...(tronOpts.defaultMaxFeeAtomic !== undefined
              ? { defaultMaxFeeAtomic: tronOpts.defaultMaxFeeAtomic }
              : {}),
          })
        : null;
  }

  /**
   * `fetch`-shaped API. On a 200 response we return the body
   * verbatim. On a 402, we parse the challenge, pick an
   * AcceptedRequirement matching our wallets + preferences, sign it,
   * and retry the same URL with the `PAYMENT-SIGNATURE` (v2) +
   * `X-PAYMENT` (v1) headers attached.
   */
  async fetch<T = unknown>(
    url: string,
    init: RequestInit = {},
  ): Promise<FetchResult<T>> {
    const first = await this.fetchImpl(url, init);
    if (first.status === 200) {
      return this.buildPassthroughResult<T>(first);
    }
    if (first.status !== 402) {
      throw new X402ClientError(
        "unexpected_status",
        `expected 200 or 402, got HTTP ${first.status} from ${url}`,
      );
    }
    const challenge = await this.readChallenge(first, url);
    // We need to know which requirement won so the receipt payer is
    // the address of the matching signer, not the EVM fallback.
    const decision = selectRequirement(challenge, this.wallets, this.preferences);
    const envelope = await this.signRequirement(decision.requirement, {
      resource: challenge.resource.url,
    });
    const headerValue = toHeaderValue(envelope);

    const retryHeaders = mergeHeaders(init.headers, {
      "PAYMENT-SIGNATURE": headerValue,
      "X-PAYMENT": headerValue, // legacy v1
    });
    const retry = await this.fetchImpl(url, { ...init, headers: retryHeaders });
    if (retry.status !== 200) {
      throw new X402ClientError(
        "payment_retry_failed",
        `retry after payment returned HTTP ${retry.status} from ${url}`,
      );
    }
    const receipt = await this.readReceipt(retry, decision.requirement);
    const data = await readBody<T>(retry);
    return { data, response: retry, payment: receipt };
  }

  /**
   * Sign for a parsed challenge without re-fetching. Returns the
   * base64 `PAYMENT-SIGNATURE` header value the buyer should attach
   * to their retry.
   */
  async signFor(
    challenge: ChallengeBody,
    prefs: Preferences = this.preferences,
  ): Promise<string> {
    const decision = selectRequirement(challenge, this.wallets, prefs);
    const envelope = await this.signRequirement(decision.requirement, {
      resource: challenge.resource.url,
    });
    return toHeaderValue(envelope);
  }

  /**
   * Alias for `signFor`. Reads more naturally at call sites where the
   * caller talks about "paying a challenge" rather than "signing for"
   * one.
   *
   * ```ts
   * const header = await client.pay(challenge);
   * ```
   */
  async pay(
    challenge: ChallengeBody,
    prefs: Preferences = this.preferences,
  ): Promise<string> {
    return this.signFor(challenge, prefs);
  }

  /**
   * Sign one specific `AcceptedRequirement` directly. Useful when the
   * caller has already decided which network to pay on (e.g. they
   * implemented their own routing).
   *
   * `options.resource` is REQUIRED for Cosmos networks — the resource
   * URL is part of the signed preimage. `.signFor(challenge)` and
   * `.fetch(url)` pass it through automatically.
   */
  async signRequirement(
    requirement: AcceptedRequirement,
    options: { resource?: string } = {},
  ): Promise<PaymentEnvelope> {
    if (requirement.network.startsWith("eip155:")) {
      if (!this.evm) {
        throw new X402ClientError(
          "no_evm_wallet",
          "configured no EVM wallet but the seller requires an EVM network",
        );
      }
      return this.evm.sign({ requirement });
    }
    if (requirement.network.startsWith("solana:")) {
      if (!this.solana) {
        throw new X402ClientError(
          "no_solana_wallet",
          "configured no Solana wallet but the seller requires a Solana network",
        );
      }
      return this.solana.sign({ requirement });
    }
    if (requirement.network.startsWith("cosmos:")) {
      if (!this.cosmos) {
        throw new X402ClientError(
          "no_cosmos_wallet",
          "configured no Cosmos wallet but the seller requires a Cosmos network",
        );
      }
      if (!options.resource) {
        throw new X402ClientError(
          "missing_resource",
          "signRequirement on a Cosmos network requires options.resource (the URL the buyer is paying for — part of the signed preimage). Pass the URL from challenge.resource.url.",
        );
      }
      return this.cosmos.sign({
        requirement,
        resource: options.resource,
      });
    }
    if (requirement.network.startsWith("tron:")) {
      if (!this.tron) {
        throw new X402ClientError(
          "no_tron_wallet",
          "configured no TRON wallet but the seller requires a TRON network",
        );
      }
      return this.tron.sign({ requirement });
    }
    throw new X402ClientError(
      "unsupported_network_family",
      `no signer for network family of ${requirement.network} (facilitator: ${this.defaultFacilitator})`,
    );
  }

  // -------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------

  private async readChallenge(
    response: Response,
    requestUrl: string,
  ): Promise<ChallengeBody> {
    // Prefer the v2 PAYMENT-REQUIRED header if the seller emitted one.
    const headerValue = response.headers.get("payment-required");
    if (headerValue) {
      return parseChallengeHeader(headerValue, requestUrl);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new X402ClientError(
        "invalid_challenge",
        `seller's 402 body is not JSON: ${(err as Error).message}`,
      );
    }
    return parseChallenge(parsed, requestUrl);
  }

  /**
   * Build a PaymentReceipt from the seller's response. Prefers values
   * extracted from the PAYMENT-RESPONSE / X-PAYMENT-RESPONSE base64
   * header (v2 emits PAYMENT-RESPONSE; v1 emits X-PAYMENT-RESPONSE);
   * falls back to the requirement we paid against so the caller still
   * gets a populated `network`/`scheme`/`amount` even when the seller
   * forgot to set the response header. The `payer` field is keyed off
   * the actual signer that produced the payment, NOT a global default.
   */
  private async readReceipt(
    response: Response,
    requirement: AcceptedRequirement,
  ): Promise<PaymentReceipt> {
    const fallbackPayer = await this.payerFor(requirement.network);
    const headerValue =
      response.headers.get("payment-response") ??
      response.headers.get("x-payment-response");
    if (!headerValue) {
      return {
        network: requirement.network,
        scheme: requirement.scheme,
        asset: requirement.asset,
        amount: requirement.amount,
        payer: fallbackPayer,
        payTo: requirement.payTo,
        txHash: null,
      };
    }
    let decoded: Record<string, unknown> | null = null;
    try {
      decoded = JSON.parse(
        Buffer.from(headerValue, "base64").toString("utf8"),
      ) as Record<string, unknown>;
    } catch {
      decoded = null;
    }
    if (decoded === null) {
      return {
        network: requirement.network,
        scheme: requirement.scheme,
        asset: requirement.asset,
        amount: requirement.amount,
        payer: fallbackPayer,
        payTo: requirement.payTo,
        txHash: null,
      };
    }
    return {
      network: pickString(decoded["network"], requirement.network),
      scheme: pickString(decoded["scheme"], requirement.scheme),
      asset: requirement.asset,
      amount: pickString(decoded["amount"], requirement.amount),
      payer: pickString(decoded["payer"], fallbackPayer),
      payTo: requirement.payTo,
      txHash:
        typeof decoded["transaction"] === "string"
          ? (decoded["transaction"] as string)
          : typeof decoded["txHash"] === "string"
            ? (decoded["txHash"] as string)
            : null,
    };
  }

  /**
   * Resolve the buyer's address for the family that owns `network`,
   * using whichever signer is configured. Returns "" when there is no
   * signer for that family — keeps the receipt populated without
   * throwing on best-effort parsing.
   */
  private async payerFor(network: string): Promise<string> {
    if (network.startsWith("eip155:")) return this.evm?.address ?? "";
    if (network.startsWith("solana:")) return this.solana?.address ?? "";
    if (network.startsWith("cosmos:")) {
      if (!this.cosmos) return "";
      try {
        return await this.cosmos.address(network);
      } catch {
        return "";
      }
    }
    if (network.startsWith("tron:")) return this.tron?.address ?? "";
    return "";
  }

  private async buildPassthroughResult<T>(
    response: Response,
  ): Promise<FetchResult<T>> {
    const data = await readBody<T>(response);
    return {
      data,
      response,
      payment: {
        network: "",
        scheme: "",
        asset: "",
        amount: "0",
        payer: "",
        payTo: "",
        txHash: null,
      },
    };
  }
}

async function readBody<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

function mergeHeaders(
  base: RequestInit["headers"],
  extra: Record<string, string>,
): Headers {
  const out = new Headers(base);
  for (const [k, v] of Object.entries(extra)) out.set(k, v);
  return out;
}

function pickString(candidate: unknown, fallback: string): string {
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : fallback;
}
