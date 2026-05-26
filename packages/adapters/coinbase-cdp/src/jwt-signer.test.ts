import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCdpJwtSigner } from "./jwt-signer.js";

function freshEd25519KeyBase64(): string {
  // CDP stores secrets as base64 of (32-byte seed || 32-byte pubkey).
  // Node's generateKeyPairSync yields DER-formatted keys; we have to
  // pluck the 32-byte raw seed and pubkey out by hand for this fixture.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privDer = privateKey.export({ format: "der", type: "pkcs8" });
  // PKCS#8 Ed25519 final 32 bytes = raw seed
  const seed = privDer.subarray(privDer.length - 32);
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  // SubjectPublicKeyInfo Ed25519 final 32 bytes = raw pubkey
  const pub = pubDer.subarray(pubDer.length - 32);
  return Buffer.concat([seed, pub]).toString("base64");
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
} {
  const [h, p, s] = token.split(".");
  if (h === undefined || p === undefined || s === undefined) {
    throw new Error(`Malformed JWT: ${token}`);
  }
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  return { header, payload, signature: s };
}

describe("createCdpJwtSigner", () => {
  it("signs a JWT whose claims match the CDP authentication spec", async () => {
    const secret = freshEd25519KeyBase64();
    const signer = createCdpJwtSigner({
      apiKeyName: "organizations/abc/apiKeys/def",
      apiKeySecret: secret,
    });
    const token = await signer.sign({
      method: "POST",
      host: "api.cdp.coinbase.com",
      path: "/platform/v2/x402/verify",
    });
    const { header, payload, signature } = decodeJwt(token);

    expect(header).toMatchObject({
      alg: "EdDSA",
      typ: "JWT",
      kid: "organizations/abc/apiKeys/def",
    });
    expect(typeof header["nonce"]).toBe("string");
    expect((header["nonce"] as string).length).toBeGreaterThanOrEqual(16);

    expect(payload).toMatchObject({
      sub: "organizations/abc/apiKeys/def",
      iss: "cdp",
      aud: ["cdp_service"],
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    });
    expect(typeof payload["nbf"]).toBe("number");
    expect(typeof payload["exp"]).toBe("number");
    expect(payload["exp"]).toBeGreaterThan(payload["nbf"] as number);
    expect(signature.length).toBeGreaterThan(0);
  });

  it("issues distinct nonces and signatures on consecutive calls", async () => {
    const secret = freshEd25519KeyBase64();
    const signer = createCdpJwtSigner({
      apiKeyName: "kid-1",
      apiKeySecret: secret,
    });
    const a = await signer.sign({ method: "GET", host: "h", path: "/p" });
    const b = await signer.sign({ method: "GET", host: "h", path: "/p" });
    const ah = decodeJwt(a).header;
    const bh = decodeJwt(b).header;
    expect(ah["nonce"]).not.toBe(bh["nonce"]);
    expect(a).not.toBe(b);
  });

  it("respects a custom ttlSeconds", async () => {
    const secret = freshEd25519KeyBase64();
    const signer = createCdpJwtSigner({
      apiKeyName: "kid-1",
      apiKeySecret: secret,
      ttlSeconds: 30,
    });
    const token = await signer.sign({ method: "GET", host: "h", path: "/p" });
    const { payload } = decodeJwt(token);
    const ttl = (payload["exp"] as number) - (payload["nbf"] as number);
    expect(ttl).toBe(30);
  });

  it("rejects an out-of-range ttlSeconds", () => {
    const secret = freshEd25519KeyBase64();
    expect(() =>
      createCdpJwtSigner({
        apiKeyName: "kid-1",
        apiKeySecret: secret,
        ttlSeconds: 500,
      }),
    ).toThrow(/ttlSeconds/);
  });

  it("rejects a too-short base64 secret", () => {
    expect(() =>
      createCdpJwtSigner({
        apiKeyName: "kid-1",
        apiKeySecret: Buffer.from("short").toString("base64"),
      }),
    ).toThrow(/too short/);
  });
});
