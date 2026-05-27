import { z } from "zod";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import {
  cosmosPrefix,
  isCosmosNetwork,
  isEvmNetwork,
  isSupportedNetwork,
  SUPPORTED_NETWORKS,
} from "../networks.js";
import { Session, type SessionStore } from "../session.js";
import type { Config } from "../config.js";

export const InitSessionInputShape = {
  secret: z
    .string()
    .min(1, "secret is required")
    .describe(
      "A 12 or 24 word BIP-39 mnemonic, OR a 0x-prefixed hex secp256k1 private key. " +
        "Held in memory only for the lifetime of this session. " +
        "NEVER logged, NEVER persisted, NEVER transmitted outside this server.",
    ),
  networks: z
    .array(z.string())
    .min(1, "at least one network is required")
    .describe(
      `Supported CAIP-2 networks: ${SUPPORTED_NETWORKS.join(", ")}. ` +
        "cosmos:noble-1 (mainnet) is intentionally NOT supported in Phase 2.",
    ),
} as const;

export const InitSessionInput = z.object(InitSessionInputShape);
export type InitSessionInput = z.infer<typeof InitSessionInput>;

export interface InitSessionDeps {
  store: SessionStore;
  config: Config;
}

export interface InitSessionResult {
  sessionId: string;
  addresses: Record<string, string>;
  expiresAt: string;
  networks: string[];
}

const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function detectSecretShape(secret: string): "mnemonic" | "privateKey" {
  if (HEX_PRIVATE_KEY.test(secret)) return "privateKey";
  return "mnemonic";
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Validate the secret shape WITHOUT logging it. Throws an Error whose
 * `message` is safe to surface to the caller — it never contains any
 * portion of the secret itself.
 */
function assertSecretShape(secret: string): "mnemonic" | "privateKey" {
  const shape = detectSecretShape(secret);
  if (shape === "privateKey") {
    if (!HEX_PRIVATE_KEY.test(secret)) {
      throw new Error("invalid private key: expected 0x-prefixed 32-byte hex");
    }
    return "privateKey";
  }
  const n = countWords(secret);
  if (n !== 12 && n !== 24) {
    throw new Error(
      `invalid mnemonic: expected 12 or 24 BIP-39 words, got ${n}`,
    );
  }
  return "mnemonic";
}

async function deriveCosmosAddress(
  secret: string,
  network: string,
): Promise<string> {
  const prefix = cosmosPrefix(network);
  // DirectSecp256k1HdWallet only accepts mnemonics. Private-key derivation
  // for Cosmos is not supported in Phase 2; reject early with a clear
  // message rather than silently using a different path.
  if (detectSecretShape(secret) === "privateKey") {
    throw new Error(
      `cosmos networks require a mnemonic; raw private keys are not supported (${network})`,
    );
  }
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(secret, { prefix });
  const [account] = await wallet.getAccounts();
  if (!account) {
    throw new Error("cosmos wallet did not produce an account");
  }
  return account.address;
}

function deriveEvmAddress(secret: string): string {
  const account =
    detectSecretShape(secret) === "privateKey"
      ? privateKeyToAccount(secret as `0x${string}`)
      : mnemonicToAccount(secret);
  return account.address;
}

/**
 * Implementation of the init_session MCP tool. Returns a structured result
 * on success or a structured error on validation failure. NEVER throws
 * with a message that contains any portion of the secret.
 */
export async function handleInitSession(
  input: InitSessionInput,
  deps: InitSessionDeps,
): Promise<
  | { ok: true; result: InitSessionResult }
  | { ok: false; error: { code: string; message: string } }
> {
  try {
    assertSecretShape(input.secret);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "invalid_secret",
        message: err instanceof Error ? err.message : "invalid secret",
      },
    };
  }

  const unsupported = input.networks.filter((n) => !isSupportedNetwork(n));
  if (unsupported.length > 0) {
    return {
      ok: false,
      error: {
        code: "unsupported_network",
        message:
          `unsupported network(s): ${unsupported.join(", ")}. ` +
          `supported: ${SUPPORTED_NETWORKS.join(", ")}`,
      },
    };
  }

  const addresses: Record<string, string> = {};
  for (const network of input.networks) {
    try {
      if (isCosmosNetwork(network)) {
        addresses[network] = await deriveCosmosAddress(input.secret, network);
      } else if (isEvmNetwork(network)) {
        addresses[network] = deriveEvmAddress(input.secret);
      } else {
        // Defensive: SUPPORTED_NETWORKS membership should have caught this.
        return {
          ok: false,
          error: {
            code: "unsupported_network",
            message: `cannot derive address for ${network}`,
          },
        };
      }
    } catch (err) {
      // err.message may legitimately mention shape problems (word count,
      // hex length); it must NEVER echo back the secret. The helpers above
      // are written so that's safe.
      return {
        ok: false,
        error: {
          code: "derivation_failed",
          message:
            err instanceof Error
              ? `derivation failed for ${network}: ${err.message}`
              : `derivation failed for ${network}`,
        },
      };
    }
  }

  const secretBytes = Buffer.from(input.secret, "utf8");
  const session = new Session({
    secretBytes,
    networks: input.networks,
    addresses,
    timeoutMs: deps.config.sessionTimeoutMs,
  });
  deps.store.put(session);

  return {
    ok: true,
    result: {
      sessionId: session.id,
      addresses: session.addresses,
      networks: [...session.networks],
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
  };
}
