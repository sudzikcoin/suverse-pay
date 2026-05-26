import { createPrivateKey, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";

/**
 * Coinbase CDP JWT signer.
 *
 * Generates a short-lived (default 120s) bearer JWT per request,
 * matching the format CDP's REST APIs expect:
 *
 *   Header  { alg: "EdDSA" | "ES256", typ: "JWT", kid, nonce }
 *   Payload { sub, iss: "cdp", aud: ["cdp_service"], nbf, exp, uri }
 *
 * Reference:
 * https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
 *
 * Only EdDSA (Ed25519) is supported here. ES256 (legacy ECDSA) keys
 * still work with CDP today but are flagged as legacy in the docs;
 * adding them is a small extension if a future user needs it.
 */
export interface CdpJwtSignerConfig {
  /** API key identifier — e.g. `organizations/{org}/apiKeys/{key}`. */
  apiKeyName: string;
  /**
   * Base64-encoded 64-byte Ed25519 keypair as exported from the CDP
   * portal (32-byte seed concatenated with 32-byte pubkey).
   */
  apiKeySecret: string;
  /** Optional override for testing. Defaults to 120 (CDP's hard limit). */
  ttlSeconds?: number;
}

export interface SignRequestParams {
  method: string;
  host: string;
  path: string;
}

const PKCS8_ED25519_HEADER = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function loadEd25519PrivateKey(base64Secret: string): KeyObject {
  const decoded = Buffer.from(base64Secret, "base64");
  if (decoded.length < 32) {
    throw new Error(
      "CDP Ed25519 secret is too short (expected 32+ bytes after base64 decode)",
    );
  }
  const seed = decoded.subarray(0, 32);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_HEADER, seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export interface CdpJwtSigner {
  sign(params: SignRequestParams): Promise<string>;
}

export function createCdpJwtSigner(config: CdpJwtSignerConfig): CdpJwtSigner {
  const ttlSeconds = config.ttlSeconds ?? 120;
  if (ttlSeconds < 10 || ttlSeconds > 120) {
    throw new Error(
      `CDP JWT ttlSeconds must be in [10, 120]; got ${ttlSeconds}`,
    );
  }
  const key = loadEd25519PrivateKey(config.apiKeySecret);

  return {
    async sign(params: SignRequestParams): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const uri = `${params.method.toUpperCase()} ${params.host}${params.path}`;
      return new SignJWT({
        sub: config.apiKeyName,
        iss: "cdp",
        aud: ["cdp_service"],
        uri,
      })
        .setProtectedHeader({
          alg: "EdDSA",
          typ: "JWT",
          kid: config.apiKeyName,
          nonce: randomNonce(),
        })
        .setNotBefore(now)
        .setExpirationTime(now + ttlSeconds)
        .sign(key);
    },
  };
}
