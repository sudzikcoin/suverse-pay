import { describe, expect, it } from "vitest";
import { Bip39, EnglishMnemonic, Random, Secp256k1, Sha256, Slip10, Slip10Curve, stringToPath } from "@cosmjs/crypto";
import { fromBase64, toBech32 } from "@cosmjs/encoding";
import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import {
  COSMOS_HD_PATH,
  COSMOS_SCHEME,
  CosmosSigner,
  adr036Preimage,
  canonicalAuthorizationJson,
  signCosmosPayment,
  toHeaderValue,
  type Authorization,
} from "../src/signers/cosmos.js";
import {
  COSMOS_NOBLE_MAINNET,
  COSMOS_NOBLE_TESTNET,
} from "../src/network/cosmos-networks.js";
import type { AcceptedRequirement } from "../src/types.js";
import { X402ClientError } from "../src/types.js";

// Pinned test mnemonic — well-known BIP-39 string from the spec
// (NOT a real wallet). Derives the same noble1… address every time
// so we can pin downstream expectations.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PAY_TO = "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj";
const FACILITATOR = "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt";
const RESOURCE = "https://agentos.suverse.io/v1/freight/parse_ratecon";
const FIXED_NONCE = "0x" + "ab".repeat(32);
const FIXED_NOW = 1_700_000_000;

function reqFor(
  network: string = COSMOS_NOBLE_MAINNET,
  overrides: Partial<AcceptedRequirement> = {},
): AcceptedRequirement {
  return {
    scheme: COSMOS_SCHEME,
    network,
    asset: "uusdc",
    payTo: PAY_TO,
    amount: "70000",
    maxTimeoutSeconds: 60,
    extra: {
      facilitator: FACILITATOR,
      chainId: network.slice("cosmos:".length),
    },
    ...overrides,
  };
}

// Derive the expected address for this pinned mnemonic so tests can
// pin "what should the from-address look like" without hardcoding a
// magic string up here.
async function expectedAddress(prefix: string): Promise<string> {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(TEST_MNEMONIC));
  const { privkey } = Slip10.derivePath(
    Slip10Curve.Secp256k1,
    seed,
    stringToPath(COSMOS_HD_PATH),
  );
  const kp = await Secp256k1.makeKeypair(privkey);
  const compressed = Secp256k1.compressPubkey(kp.pubkey);
  return toBech32(prefix, rawSecp256k1PubkeyToRawAddress(compressed));
}

describe("canonicalAuthorizationJson", () => {
  it("sorts keys lexicographically", () => {
    const auth: Authorization = {
      from: "noble1aaa",
      to: "noble1bbb",
      denom: "uusdc",
      amount: "100",
      nonce: "0x" + "0".repeat(64),
      validAfter: 100,
      validBefore: 200,
      resource: "https://x/y",
      chainId: "noble-1",
    };
    const json = canonicalAuthorizationJson(auth);
    // Keys must appear in lexical order: amount, chainId, denom, from,
    // nonce, resource, to, validAfter, validBefore
    const order = json.match(/"(\w+)":/g)?.map((m) => m.slice(1, -2));
    expect(order).toEqual([
      "amount",
      "chainId",
      "denom",
      "from",
      "nonce",
      "resource",
      "to",
      "validAfter",
      "validBefore",
    ]);
  });

  it("HTML-escapes & < > inside string values", () => {
    const auth: Authorization = {
      from: "noble1aaa",
      to: "noble1bbb",
      denom: "uusdc",
      amount: "100",
      nonce: "0x" + "0".repeat(64),
      validAfter: 100,
      validBefore: 200,
      resource: "https://x/y?a=1&b=2",
      chainId: "noble-1",
    };
    const json = canonicalAuthorizationJson(auth);
    expect(json).toContain("a=1\\u0026b=2");
    expect(json).not.toContain("a=1&b=2");
  });
});

describe("adr036Preimage", () => {
  it("matches the well-known outer doc shape", () => {
    const auth: Authorization = {
      from: "noble1aaa",
      to: "noble1bbb",
      denom: "uusdc",
      amount: "100",
      nonce: "0x" + "1".repeat(64),
      validAfter: 100,
      validBefore: 200,
      resource: "https://x/y",
      chainId: "noble-1",
    };
    const bytes = adr036Preimage(auth, "noble1aaa");
    const json = new TextDecoder().decode(bytes);
    // Outer doc fields in lexical order: account_number, chain_id,
    // fee, memo, msgs, sequence.
    const order = json.match(/"(account_number|chain_id|fee|memo|msgs|sequence)":/g);
    expect(order).toEqual([
      '"account_number":',
      '"chain_id":',
      '"fee":',
      '"memo":',
      '"msgs":',
      '"sequence":',
    ]);
    expect(json).toContain('"type":"sign/MsgSignData"');
  });
});

describe("CosmosSigner construction", () => {
  it("accepts a 12-word mnemonic", () => {
    expect(() => new CosmosSigner({ wallet: TEST_MNEMONIC })).not.toThrow();
  });

  it("accepts a 32-byte raw privkey Uint8Array", () => {
    expect(
      () => new CosmosSigner({ wallet: Random.getBytes(32) }),
    ).not.toThrow();
  });

  it("rejects wrong word count", () => {
    expect(
      () => new CosmosSigner({ wallet: "abandon abandon abandon" }),
    ).toThrowError(X402ClientError);
  });

  it("rejects wrong-length Uint8Array", () => {
    expect(
      () => new CosmosSigner({ wallet: new Uint8Array(16) }),
    ).toThrowError(X402ClientError);
  });

  it("supportedNetworks returns noble-1 + grand-1", () => {
    const list = CosmosSigner.supportedNetworks();
    expect(list).toContain(COSMOS_NOBLE_MAINNET);
    expect(list).toContain(COSMOS_NOBLE_TESTNET);
  });

  it("address resolves the pinned mnemonic's noble address", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const addr = await signer.address(COSMOS_NOBLE_MAINNET);
    expect(addr).toMatch(/^noble1[02-9ac-hj-np-z]+$/);
    expect(addr).toBe(await expectedAddress("noble"));
  });
});

describe("CosmosSigner.sign — happy path on noble-1", () => {
  it("produces a v2 envelope with the expected wire shape", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const envelope = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.scheme).toBe(COSMOS_SCHEME);
    expect(envelope.network).toBe(COSMOS_NOBLE_MAINNET);

    const payload = envelope.payload as Record<string, unknown>;
    expect(payload.from).toBe(await expectedAddress("noble"));
    expect(typeof payload.publicKey).toBe("string");
    expect(typeof payload.signature).toBe("string");

    // 33-byte compressed pubkey, base64 → 44 chars (with padding) or
    // 45 with newline; accept both.
    const pk = fromBase64(payload.publicKey as string);
    expect(pk.length).toBe(33);

    // 64-byte r||s signature
    const sig = fromBase64(payload.signature as string);
    expect(sig.length).toBe(64);

    const auth = payload.authorization as Record<string, unknown>;
    expect(auth.denom).toBe("uusdc");
    expect(auth.amount).toBe("70000");
    expect(auth.chainId).toBe("noble-1");
    expect(auth.resource).toBe(RESOURCE);
    // validAfter + validBefore must be NUMBERS on the wire
    expect(typeof auth.validAfter).toBe("number");
    expect(typeof auth.validBefore).toBe("number");
    expect(auth.validBefore).toBe((auth.validAfter as number) + 60);
    expect(auth.nonce).toBe(FIXED_NONCE);
  });

  it("clamps validitySeconds down to requirement.maxTimeoutSeconds", async () => {
    const signer = new CosmosSigner({
      wallet: TEST_MNEMONIC,
      validitySeconds: 600,
    });
    const req: AcceptedRequirement = { ...reqFor(), maxTimeoutSeconds: 30 };
    const envelope = await signer.sign({
      requirement: req,
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    const auth = (envelope.payload as Record<string, unknown>)
      .authorization as Record<string, number>;
    expect(auth.validBefore - auth.validAfter).toBe(30);
  });

  it("signature is deterministic when (mnemonic, auth, nonce, now) pinned", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const a = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    const b = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    expect((a.payload as Record<string, unknown>).signature).toBe(
      (b.payload as Record<string, unknown>).signature,
    );
  });

  it("different nonce → different signature", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const a = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: "0x" + "11".repeat(32),
    });
    const b = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: "0x" + "22".repeat(32),
    });
    expect((a.payload as Record<string, unknown>).signature).not.toBe(
      (b.payload as Record<string, unknown>).signature,
    );
  });
});

describe("CosmosSigner.sign — signature verifies with secp256k1.verify", () => {
  it("produced signature recovers via Secp256k1.verifySignature", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const envelope = await signer.sign({
      requirement: reqFor(),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    const payload = envelope.payload as Record<string, unknown>;
    const auth = payload.authorization as Authorization;
    const preimage = adr036Preimage(auth, auth.from);
    const digest = new Sha256(preimage).digest();
    const sigBytes = fromBase64(payload.signature as string);
    const pkBytes = fromBase64(payload.publicKey as string);
    // @cosmjs/crypto's verifySignature uses an extended-sig object;
    // build it from the 64-byte r||s.
    const extSig = await Secp256k1.createSignature(digest, await deriveRawPriv());
    void extSig; // silence unused — verify below uses parsed signature
    const { Secp256k1Signature } = await import("@cosmjs/crypto");
    const parsed = Secp256k1Signature.fromFixedLength(sigBytes);
    const ok = await Secp256k1.verifySignature(parsed, digest, pkBytes);
    expect(ok).toBe(true);
  });

  async function deriveRawPriv(): Promise<Uint8Array> {
    const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(TEST_MNEMONIC));
    const { privkey } = Slip10.derivePath(
      Slip10Curve.Secp256k1,
      seed,
      stringToPath(COSMOS_HD_PATH),
    );
    return privkey;
  }
});

describe("CosmosSigner.sign — rejections", () => {
  it("rejects a non-cosmos_authz scheme", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    await expect(
      signer.sign({
        requirement: { ...reqFor(), scheme: "exact" },
        resource: RESOURCE,
      }),
    ).rejects.toThrowError(/scheme/);
  });

  it("rejects an unsupported network", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    await expect(
      signer.sign({
        requirement: { ...reqFor(), network: "cosmos:other-1" },
        resource: RESOURCE,
      }),
    ).rejects.toThrowError(/recognised/);
  });

  it("rejects missing extra.facilitator", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    await expect(
      signer.sign({
        requirement: { ...reqFor(), extra: { chainId: "noble-1" } },
        resource: RESOURCE,
      }),
    ).rejects.toThrowError(/facilitator/);
  });

  it("rejects empty resource", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    await expect(
      signer.sign({
        requirement: reqFor(),
        resource: "",
      }),
    ).rejects.toThrowError(/resource/);
  });

  it("rejects when extra.chainId disagrees with registry", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    await expect(
      signer.sign({
        requirement: {
          ...reqFor(),
          extra: { facilitator: FACILITATOR, chainId: "noble-99" },
        },
        resource: RESOURCE,
      }),
    ).rejects.toThrowError(/chainId/);
  });
});

describe("CosmosSigner — testnet", () => {
  it("signs cleanly on cosmos:grand-1", async () => {
    const signer = new CosmosSigner({ wallet: TEST_MNEMONIC });
    const envelope = await signer.sign({
      requirement: reqFor(COSMOS_NOBLE_TESTNET),
      resource: RESOURCE,
      nowOverride: FIXED_NOW,
      nonceOverride: FIXED_NONCE,
    });
    expect(envelope.network).toBe(COSMOS_NOBLE_TESTNET);
    const auth = (envelope.payload as Record<string, unknown>)
      .authorization as Record<string, unknown>;
    expect(auth.chainId).toBe("grand-1");
  });
});

describe("toHeaderValue + signCosmosPayment shim", () => {
  it("toHeaderValue produces base64 round-trippable JSON", async () => {
    const env = await signCosmosPayment({
      wallet: TEST_MNEMONIC,
      requirement: reqFor(),
      resource: RESOURCE,
    });
    const header = toHeaderValue(env);
    expect(header).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const back = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    expect(back.x402Version).toBe(2);
    expect(back.scheme).toBe(COSMOS_SCHEME);
  });
});
