# real-evm smoke

End-to-end smoke for Coinbase CDP settlement on **Base Sepolia**
(`eip155:84532`). Each `04-settle.sh` / `06-facilitator-settle.sh` run
broadcasts a real `transferWithAuthorization` to Base Sepolia via CDP
and asserts the on-chain receipt status is `0x1`.

This suite is the v0.3.1 closer for Sub-task 4 of Phase 3 — the
deferred Coinbase CDP real-network smoke that was gated on a CDP API
key until 2026-05-28.

## What you need

1. **CDP credentials** in `.env` (project root):
   - `COINBASE_CDP_API_KEY_NAME`
   - `COINBASE_CDP_API_KEY_SECRET`

2. **A funded Base Sepolia test wallet** at `.env.evm-sepolia` (root,
   mode 600, gitignored). Generate with:

       pnpm tsx packages/signers/evm/scripts/gen-evm-sepolia-wallet.mts

   The file is structured as:

       EVM_TESTNET_MNEMONIC="<12 words>"
       EVM_TESTNET_ADDRESS=0x...

   Fund the address with:
   - **ETH-Sepolia** for gas (a few drops from the Coinbase CDP faucet
     or any Base Sepolia faucet)
   - **USDC-Sepolia** at the test deployment
     `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Coinbase CDP faucet
     dispenses ~1 USDC at a time)

   At default settings each smoke run consumes
   `2 × SMOKE_REVM_AMOUNT_ATOMIC` USDC atomic units (= 0.0002 USDC).

3. **`suverse-pay` running on :3000** with `.env` sourced into the
   process — the gateway only registers `coinbase-cdp` when the CDP
   env vars are present at boot. Restart with:

       set -a && source .env && set +a
       pnpm --filter @suverse-pay/api dev

4. **Postgres + Redis** up (Docker compose).

## What each step proves

| step | endpoint | proves |
|------|----------|--------|
| 00-setup | (env probes) | CDP creds present, wallet funded, gateway sees `eip155:84532`, fresh resource key bootstrapped |
| 01-supported | `/providers`, `/facilitator/supported` | both admin + public surfaces advertise the Base Sepolia route |
| 02-quote | `POST /quote` | synthetic CDP quote returned (CDP has no native quote endpoint) |
| 03-verify | `POST /verify` | CDP accepts the EIP-3009 signature (no broadcast, nonce not consumed) |
| 04-settle | `POST /settle` (admin) | REAL Base Sepolia tx via internal path — captures txHash + waits for receipt |
| 05-settle-idempotent | `POST /settle` (admin, same idem + same nonce) | Same `paymentId` + same `txHash` returned, exactly one attempt in DB (no second on-chain broadcast) |
| 06-facilitator-settle | `POST /facilitator/settle` (public) | REAL Base Sepolia tx via the public x402 facilitator surface — fresh nonce, different `txHash` from 04 |
| 99-teardown | (revoke key) | resource key marked `is_active=FALSE`, plaintext wiped from /tmp |

## Running

    set -a && source .env && set +a
    bash scripts/smoke/real-evm/run-all.sh

Output:

    ━━━ 00-setup ━━━
      ✓ ADMIN_API_KEY set
      ✓ CDP credentials present in environment
      ✓ test wallet address: 0xA2F8...538E
      ...
    ━━━ 04-settle ━━━ POST /settle — REAL on-chain Base Sepolia broadcast via CDP
      ✓ settled pay_... via coinbase-cdp on Base Sepolia
      • tx hash: 0x...
      • explorer: https://sepolia.basescan.org/tx/0x...
      ✓ on-chain receipt confirmed status=0x1
    ━━━ summary ━━━
      PASS  00-setup
      ...
      PASS  06-facilitator-settle

      • internal-settle tx:    https://sepolia.basescan.org/tx/0x...
      • facilitator-settle tx: https://sepolia.basescan.org/tx/0x...

## Cost

At `SMOKE_REVM_AMOUNT_ATOMIC=1000` (default, = 0.001 USDC — CDP
enforces a 1000-atomic minimum on Base Sepolia; values below that
come back as `amount_too_low`):

- 04-settle:             0.001 USDC + Base Sepolia gas (~0.000002 ETH)
- 06-facilitator-settle: 0.001 USDC + Base Sepolia gas

Total per run: **~0.002 USDC + ~0.000004 ETH**. The wallet should
hold at least `SMOKE_REVM_AMOUNT_ATOMIC × 3` atomic USDC and a few
drops of ETH-Sepolia. 00-setup enforces this and fails fast otherwise.

## Cost knobs (env overrides)

- `SMOKE_REVM_AMOUNT_ATOMIC` (default `1000`): atomic USDC per settle (CDP min on Base Sepolia is 1000)

### Running on a different CDP-supported network

Override the network + asset + RPC + explorer together. Example —
World Sepolia (eip155:4801, added in v0.3.2):

    export SMOKE_REVM_NETWORK=eip155:4801
    export SMOKE_REVM_USDC=0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88
    export SMOKE_REVM_RPC=https://worldchain-sepolia.g.alchemy.com/public
    export SMOKE_REVM_EXPLORER=https://sepolia.worldscan.org

    set -a && source .env && set +a
    bash scripts/smoke/real-evm/run-all.sh

The test wallet at `.env.evm-sepolia` must be funded on the chosen
chain (a few drops of native gas + at least `SMOKE_REVM_AMOUNT_ATOMIC
× 3` atomic USDC). 00-setup will check on-chain balances and fail
fast if either is missing.

| Network | RPC suggestion | Explorer | USDC contract |
|---|---|---|---|
| Base Sepolia (84532) | `https://sepolia.base.org` | `https://sepolia.basescan.org` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| World Sepolia (4801) | `https://worldchain-sepolia.g.alchemy.com/public` | `https://sepolia.worldscan.org` | `0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88` |
| SKALE Base Sepolia (324705682) | `https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha` | `https://skale-base-sepolia-explorer.skalenodes.com` | `0x2e08028E3C4c2356572E096d8EF835cD5C6030bD` |

### SKALE Base Sepolia funding (Phase 5 Sub-task 7)

SKALE Base is an L3 with a CREDIT-prepay gas model, so the smoke
buyer wallet only needs **USDC.e** balance — gas is paid by the
facilitator (PayAI in our case) out of pre-funded operator CREDIT.

1. **Faucet URL:** [`base-sepolia-faucet.skale.space`](https://base-sepolia-faucet.skale.space)
   — paste the test wallet address into the form. The faucet drips
   a small amount of CREDIT (handy for direct contract reads;
   x402 buyers do not need it). The faucet uses a manual web
   captcha — there is no programmatic POST endpoint we can rely
   on. If automation ever becomes necessary,
   `POST /api/faucet { address }` is the route the page wires to.
2. **Test USDC.e:** bridge a small balance from Base Sepolia
   (eip155:84532) into SKALE Base Sepolia via the SKALE bridge UI
   at `https://base-sepolia.skalenodes.com/chains/base`. Allow
   a couple of minutes for IMA confirmation.

Note that CDP does NOT advertise SKALE Base on `/supported` — the
default 04-settle / 06-facilitator-settle steps target the CDP
adapter and will fail closed for `eip155:1187947933` until a
PayAI-backed smoke variant lands alongside S7. For now, this row
documents the network surface; the actual end-to-end script
arrives with the PayAI testnet smoke in Sub-task 7.

Mainnet networks (Base 8453, Polygon 137, Arbitrum 42161, World
Chain 480) can be parametrized the same way but each settle moves
real money — fund a wallet you control, and budget for at least
`SMOKE_REVM_AMOUNT_ATOMIC × 3` atomic units of mainnet USDC.
- `SMOKE_REVM_PAY_TO` (default `0x000000000000000000000000000000000000bEEF`): recipient address (any non-zero EVM address)
- `SMOKE_REVM_NETWORK` (default `eip155:84532`): CAIP-2 (set to `eip155:8453` for mainnet — DO NOT do this casually)
- `SMOKE_REVM_USDC` (default `0x036CbD53842c5426634e7929541eC2318f3dCF7e`): USDC contract on the chosen network
- `BASE_URL` (default `http://127.0.0.1:3000`)

## Idempotency

Step 04 stashes the signed fixture + Idempotency-Key + paymentId +
txHash. Step 05 re-POSTs the SAME fixture with the SAME
Idempotency-Key — no re-signing, same nonce. The gateway must return
the same `paymentId` + same `txHash` and `/payments/:id` must show
exactly one attempt row. If CDP had been called twice we'd see two
attempt rows AND likely two on-chain txs (or one revert because the
EIP-3009 nonce was already consumed).

## Why two settle paths (04 + 06)

`POST /settle` is the internal admin path used by integrations the
gateway operator owns. `POST /facilitator/settle` is the public x402
spec §7.2 endpoint used by third-party resource servers that adopt
suverse-pay as their facilitator URL. They share most of the
orchestration but differ in auth (Bearer admin vs Bearer resource
key), rate limiting (per-key), idempotency-key derivation, and the
response envelope (gateway-shape vs `{success, transaction, network}`).

Through v0.3.0 only Cosmos was real-tested via the facilitator
surface (Sub-task 7 of Phase 3); v0.3.1 closes the EVM half.
