import { rawSecp256k1PubkeyToRawAddress } from "@cosmjs/amino";
import {
  Bip39,
  EnglishMnemonic,
  Secp256k1,
  Slip10,
  Slip10Curve,
  stringToPath,
} from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";

/** HD derivation path used by Cosmos SDK wallets, including Noble. */
export const COSMOS_HD_PATH = "m/44'/118'/0'/0/0";

export interface DerivedKey {
  /** 32-byte raw private key. NEVER serialize. */
  readonly privkey: Uint8Array;
  /** 33-byte compressed secp256k1 pubkey. */
  readonly pubkeyCompressed: Uint8Array;
  /** bech32-encoded address using the requested prefix. */
  readonly address: string;
}

/**
 * Derive a Cosmos key + address from a BIP-39 mnemonic at the standard
 * Cosmos HD path. Matches what cosmos-sdk and Keplr produce for the same
 * mnemonic, and what x402-cosmos/tools/fixture computes in Go.
 */
export async function deriveCosmosKey(
  mnemonic: string,
  bech32Prefix: string,
): Promise<DerivedKey> {
  const mnemonicChecked = new EnglishMnemonic(mnemonic);
  const seed = await Bip39.mnemonicToSeed(mnemonicChecked);
  const path = stringToPath(COSMOS_HD_PATH);
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, path);
  const keypair = await Secp256k1.makeKeypair(privkey);
  const pubkeyCompressed = Secp256k1.compressPubkey(keypair.pubkey);
  const address = toBech32(
    bech32Prefix,
    rawSecp256k1PubkeyToRawAddress(pubkeyCompressed),
  );
  return { privkey, pubkeyCompressed, address };
}
