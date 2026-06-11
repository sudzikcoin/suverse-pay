/**
 * MPP/Tempo payment rail (Task 39a-rescoped, migration 036).
 *
 * Implements the seller side of the Machine Payments Protocol
 * (draft-ryan-httpauth-payment) for the `tempo` method, `charge`
 * intent, as an ADDITIVE rail next to x402 on the same endpoints:
 *
 *   - challenge: the 402 response carries `WWW-Authenticate: Payment
 *     …` alongside the existing x402 JSON body + `payment-required`
 *     header. MPP lives entirely in headers, x402 in the body — the
 *     two never collide on the wire.
 *   - credential: a buyer that retries with `Authorization: Payment
 *     …` is verified and settled on Tempo by us (we broadcast the
 *     buyer-signed tx and wait for confirmation), bypassing the x402
 *     facilitator entirely.
 *
 * The rail is doubly gated: process-level (MPP_TEMPO_ENABLED +
 * MPP_SECRET_KEY in the proxy env — absent means `loadMppRail`
 * returns undefined and the handler behaves exactly as before) and
 * row-level (`seller_proxy_configs.mpp_tempo_enabled`, migration
 * 036). Tempo is an EVM chain; the row's `pay_to_evm` is reused as
 * the on-Tempo recipient, so rows without one never emit the header.
 *
 * Challenges are stateless: mppx HMAC-binds the challenge id over
 * realm|method|intent|request|expires|opaque keyed by MPP_SECRET_KEY,
 * so no challenge store is needed and any proxy replica can verify a
 * challenge issued by any other. Replay of a settled credential is
 * rejected at verification time (tx hash already used on-chain).
 */

import { Credential, Receipt } from "mppx";
import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/server";

/**
 * Per-network constants. Testnet "moderato" (42431) settles in
 * pathUSD; mainnet (4217) in USDC.e. Both are TIP-20 6-decimal
 * stablecoins — `decimals` stays 6 either way, matching the 6-dp
 * atomic `price_atomic` we already store for USDC.
 */
export const TEMPO_NETWORKS = {
  testnet: {
    chainId: 42431,
    caip2: "eip155:42431",
    currency: "0x20c0000000000000000000000000000000000000", // pathUSD
    decimals: 6,
    testnet: true,
  },
  mainnet: {
    chainId: 4217,
    caip2: "eip155:4217",
    currency: "0x20C000000000000000000000b9537d11c60E8b50", // USDC.e
    decimals: 6,
    testnet: false,
  },
} as const;

export type TempoNetworkName = keyof typeof TEMPO_NETWORKS;

export interface MppChallengeInput {
  /** 6-dp atomic price, straight from `seller_proxy_configs.price_atomic`. */
  amountAtomic: string;
  /** Seller's EVM payout address, reused as the Tempo recipient. */
  recipient: string;
  /** Route scope baked into the challenge (public_slug or endpoint_slug). */
  scope: string;
  /** Human description shown by buyer tooling. */
  description?: string | undefined;
}

export type MppSettleResult =
  | {
      ok: true;
      /** Tempo tx hash (receipt.reference). */
      txHash: string;
      /** Payer address parsed from the credential's did:pkh source, if present. */
      payer: string;
      /** Serialized receipt for the `Payment-Receipt` response header. */
      receiptHeader: string;
    }
  | {
      ok: false;
      /** Short machine code for proxy_request_logs.error_code. */
      errorCode: string;
      /** One-line human detail, safe to return to the buyer. */
      message: string;
    };

/**
 * Interface the request handler depends on — tests inject fakes, the
 * boot path constructs the real `MppTempoRail` below.
 */
export interface MppRail {
  /** CAIP-2 of the settlement chain, e.g. "eip155:42431". */
  readonly network: string;
  /** Settlement currency contract address. */
  readonly asset: string;
  /** Builds the `WWW-Authenticate` value for a 402 challenge. */
  challengeHeader(input: MppChallengeInput): Promise<string>;
  /** Verifies an `Authorization: Payment …` credential and settles on Tempo. */
  verifyAndSettle(
    authorization: string,
    input: MppChallengeInput,
  ): Promise<MppSettleResult>;
}

export interface MppTempoRailOptions {
  /** HMAC key binding challenge ids. NOT a chain key — any 32+ char secret. */
  secretKey: string;
  /** MPP realm advertised in challenges, e.g. "proxy.suverse.io". */
  realm: string;
  network: TempoNetworkName;
}

export class MppTempoRail implements MppRail {
  readonly network: string;
  readonly asset: string;
  private readonly mppx: ReturnType<typeof createServerMppx>;
  private readonly chain: (typeof TEMPO_NETWORKS)[TempoNetworkName];

  constructor(opts: MppTempoRailOptions) {
    this.chain = TEMPO_NETWORKS[opts.network];
    this.network = this.chain.caip2;
    this.asset = this.chain.currency;
    this.mppx = createServerMppx(opts, this.chain);
  }

  async challengeHeader(input: MppChallengeInput): Promise<string> {
    const challenge = await this.mppx.challenge.tempo.charge({
      amount: atomicToHuman(input.amountAtomic, this.chain.decimals),
      recipient: input.recipient,
      // Buyer pays its own Tempo fee — the seller side needs no
      // funded wallet for the rail to work.
      feePayer: false,
      scope: input.scope,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
    });
    return Challenge.serialize(challenge);
  }

  async verifyAndSettle(
    authorization: string,
    input: MppChallengeInput,
  ): Promise<MppSettleResult> {
    try {
      const receipt = await this.mppx.verifyCredential(authorization, {
        scope: input.scope,
        // Pin the economic terms — a credential signed against a
        // doctored challenge (wrong amount/recipient/chain) fails
        // verification even though its HMAC self-validates.
        request: {
          amount: atomicToHuman(input.amountAtomic, this.chain.decimals),
          currency: this.chain.currency,
          recipient: input.recipient,
          chainId: this.chain.chainId,
        },
      });
      if (receipt.status !== "success") {
        return {
          ok: false,
          errorCode: `mpp_receipt_${receipt.status}`,
          message: `tempo settlement returned status=${receipt.status}`,
        };
      }
      return {
        ok: true,
        txHash: receipt.reference ?? "",
        payer: payerFromAuthorization(authorization),
        receiptHeader: Receipt.serialize(receipt),
      };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false,
        errorCode: `mpp_${(e.name || "error").replace(/Error$/, "").toLowerCase()}`,
        message: String(e.message ?? e).slice(0, 200),
      };
    }
  }
}

/**
 * Boot-time loader. Returns undefined (rail off, zero behavior
 * change) unless BOTH process-level gates are present:
 *
 *   MPP_TEMPO_ENABLED=true
 *   MPP_SECRET_KEY=<32+ char HMAC secret>
 *
 * Optional:
 *   MPP_TEMPO_NETWORK=testnet|mainnet   (default testnet)
 *   MPP_REALM=<realm>                   (default proxy.suverse.io)
 */
export function loadMppRail(
  env: NodeJS.ProcessEnv,
  log?: Pick<Console, "info" | "warn" | "error">,
): MppTempoRail | undefined {
  if (env["MPP_TEMPO_ENABLED"] !== "true") return undefined;
  const secretKey = env["MPP_SECRET_KEY"];
  if (typeof secretKey !== "string" || secretKey.length < 32) {
    log?.error?.(
      "proxy: MPP_TEMPO_ENABLED=true but MPP_SECRET_KEY missing or " +
        "shorter than 32 chars — MPP rail disabled",
    );
    return undefined;
  }
  const rawNetwork = env["MPP_TEMPO_NETWORK"] ?? "testnet";
  if (rawNetwork !== "testnet" && rawNetwork !== "mainnet") {
    log?.error?.(
      `proxy: MPP_TEMPO_NETWORK="${rawNetwork}" is not testnet|mainnet — MPP rail disabled`,
    );
    return undefined;
  }
  const realm = env["MPP_REALM"] ?? "proxy.suverse.io";
  const rail = new MppTempoRail({ secretKey, realm, network: rawNetwork });
  log?.info?.(
    `proxy: MPP/Tempo rail enabled network=${rail.network} realm=${realm}`,
  );
  return rail;
}

/**
 * True when an incoming Authorization header is an MPP `Payment`
 * credential (vs Basic/Bearer/etc, which the proxy ignores as
 * before). Scheme comparison is case-insensitive per RFC 9110.
 */
export function isMppAuthorization(value: string | undefined): value is string {
  return typeof value === "string" && /^payment\s+\S/i.test(value.trim());
}

function createServerMppx(
  opts: MppTempoRailOptions,
  chain: (typeof TEMPO_NETWORKS)[TempoNetworkName],
) {
  return Mppx.create({
    methods: [
      tempo.charge({
        testnet: chain.testnet,
        currency: chain.currency,
        decimals: chain.decimals,
        chainId: chain.chainId,
        // We broadcast the buyer-signed tx and block until the
        // receipt exists — ~1.5s on Tempo, well inside the proxy's
        // request budget, and it means a 200 ⇒ the seller was paid.
        waitForConfirmation: true,
      }),
    ],
    realm: opts.realm,
    secretKey: opts.secretKey,
  });
}

/**
 * "50000" (6 dp atomic) → "0.05". mppx's charge methods take human
 * amounts and re-atomize internally; feeding it the exact same
 * conversion at challenge AND verify time keeps the pinned request
 * byte-identical.
 */
export function atomicToHuman(atomic: string, decimals: number): string {
  const digits = atomic.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(digits)) {
    throw new Error(`atomicToHuman: non-integer atomic amount "${atomic}"`);
  }
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * Extracts the payer's address from the credential's optional
 * did:pkh source ("did:pkh:eip155:42431:0xabc…" → "0xabc…").
 * Best-effort — logging metadata only, never trusted for accounting.
 */
function payerFromAuthorization(authorization: string): string {
  try {
    const cred = Credential.deserialize(authorization);
    const source = cred.source;
    if (typeof source !== "string") return "";
    const m = /^did:pkh:[^:]+:[^:]+:(.+)$/.exec(source);
    return m?.[1] ?? source;
  } catch {
    return "";
  }
}
