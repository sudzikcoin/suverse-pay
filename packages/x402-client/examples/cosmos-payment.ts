/**
 * Cosmos (Noble mainnet) end-to-end x402 payment example.
 *
 * Drives a real $0.07 USDC settle through the AgentOS freight seller
 * at https://agentos.suverse.io/v1/freight/parse_ratecon, paid via
 * `exact_cosmos_authz` scheme on `cosmos:noble-1` (USDC = uusdc, 6dp).
 *
 * --- Pre-condition: MsgGrant on-chain ---
 *
 * Before this script can succeed, the payer wallet must have already
 * issued a `MsgGrant{SendAuthorization}` to the facilitator grantee
 *   noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt
 * on `noble-1` mainnet, authorising it to send up to N uusdc on the
 * payer's behalf. Without the grant, `cosmos-pay` rejects /verify
 * with `no_authorization`.
 *
 * Quick CLI recipe (one-time, using `nobled` or any cosmjs CLI):
 *
 *   nobled tx authz grant noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt \
 *     send --spend-limit 10000000uusdc --from <your-key> \
 *     --chain-id noble-1 --node https://noble-rpc.polkachu.com:443 \
 *     --gas auto --gas-adjustment 1.4 --fees 5000uusdc -y
 *
 * The grant is a one-shot setup; subsequent payments don't need to
 * re-grant unless the spend limit is exhausted.
 *
 * --- Running this example ---
 *
 *   COSMOS_MNEMONIC="word1 word2 ... word24" \
 *     npx tsx examples/cosmos-payment.ts
 *
 * Mnemonic is a 12 or 24-word BIP-39 phrase for a wallet on the
 * `noble` bech32 prefix that has at least $0.07 USDC and a live grant
 * to the facilitator.
 *
 * On success, the script prints the on-chain tx hash — look it up at
 *   https://www.mintscan.io/noble/txs/<HASH>
 *
 * Reproduction proof: this exact recipe (against the same AgentOS
 * endpoint, same grantee) settled tx
 *   C8A0B6F90DA9CB108E471742FAED66199D4B03F63326D216040DDC35F539A945
 * on 2026-05-30 in 5.6 s, HTTP 200, first try.
 */

import { SuverseClient } from "@suverselabs/x402-client";

const mnemonic = process.env["COSMOS_MNEMONIC"];
if (!mnemonic) {
  console.error(
    "Set COSMOS_MNEMONIC to a 12- or 24-word BIP-39 phrase for a Noble wallet.",
  );
  process.exit(1);
}

const client = new SuverseClient({
  wallets: { cosmos: mnemonic },
  preferences: { preferredNetwork: "cosmos:noble-1" },
});

const url = "https://agentos.suverse.io/v1/freight/parse_ratecon";

const { data, response, payment } = await client.fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    mode: "fast",
    text: "Rate confirmation: $2.50/mile, Chicago → Dallas, 53ft van, 42000 lbs.",
  }),
});

// `response` is the raw fetch Response (after the signed retry).
// `data` is the parsed body (JSON if Content-Type is JSON, else text).
// `payment` is the PaymentReceipt — what was paid, on which chain.
console.log(`HTTP ${response.status} from ${url}`);
console.log("");
console.log("payment.network :", payment.network);
console.log("payment.scheme  :", payment.scheme);
console.log("payment.asset   :", payment.asset);
console.log("payment.amount  :", payment.amount, "uusdc (=", payment.amount, "/ 1e6 USDC)");
console.log("payment.payer   :", payment.payer);
console.log("payment.payTo   :", payment.payTo);
console.log("payment.txHash  :", payment.txHash);
if (payment.txHash) {
  console.log(`mintscan        : https://www.mintscan.io/noble/txs/${payment.txHash}`);
}
console.log("");
console.log("seller response :", JSON.stringify(data, null, 2));
