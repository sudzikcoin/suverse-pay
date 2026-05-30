/**
 * AES-256-GCM envelope for the seller's forwarded headers
 * (upstream auth tokens, API keys, etc).
 *
 * Layout: base64( iv[12] || tag[16] || ciphertext )
 *
 * Single key, taken from the PROXY_HEADER_KEY env var (32 raw
 * bytes, base64-encoded). Rotation is left to the operator; this
 * module never picks the key — never default-generate inside a
 * production process, that would silently break decryption on
 * restart.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Resolve the master key. Throws if the env var is missing or
 * malformed — boot-time-safe failure is what we want; a started
 * proxy with no key would silently lose every seller's auth headers.
 */
export function loadMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env["PROXY_HEADER_KEY"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "PROXY_HEADER_KEY env var is required. Generate one with: " +
        "node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"base64\"))'",
    );
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(
      `PROXY_HEADER_KEY must decode to exactly 32 bytes (got ${key.length})`,
    );
  }
  return key;
}

/** Encrypt a JSON-serialisable record. Returns the base64 ciphertext. */
export function encryptHeaders(
  headers: Record<string, string>,
  key: Buffer,
): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(headers), "utf8");
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Reverse `encryptHeaders`. Throws on tampered ciphertext (the GCM
 * auth tag fails) — caller treats that as a config error
 * ('invalid_config' outcome bucket).
 */
export function decryptHeaders(
  blob: string,
  key: Buffer,
): Record<string, string> {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  const obj = JSON.parse(plaintext.toString("utf8")) as unknown;
  if (
    obj === null ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.values(obj as object).some((v) => typeof v !== "string")
  ) {
    throw new Error("decrypted blob is not a Record<string,string>");
  }
  return obj as Record<string, string>;
}
