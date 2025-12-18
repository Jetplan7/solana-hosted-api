# CLMM swap backend with AUTO token-account discovery + auto-create

This backend removes the need to manually paste token accounts.

- It derives your USDC ATA + wSOL ATA from your wallet pubkey.
- If either ATA does not exist, it adds create-ATA instructions.
  (Requires a small amount of SOL to pay rent once.)

Endpoints:
- GET /health
- GET /derive/:wallet           -> shows derived ATAs + existence
- GET /raydium-raw              -> shows best SOL/USDC pool (often CLMM)
- GET /raydium-sdk-exports      -> debug which Raydium SDK funcs exist
- POST /build-tx                -> mode=clmm_swap builds a tx (unsigned) + simulates

Build tx example:
POST /build-tx
{
  "userPublicKey": "<YOUR_WALLET>",
  "mode": "clmm_swap",
  "amountIn": 1000000,
  "minAmountOut": 0
}
