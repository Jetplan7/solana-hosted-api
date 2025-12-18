# Raydium SOL/USDC is returning CLMM (Concentrated)

Your Raydium API response shows:
- type: "Concentrated"
- programId: CAMMC...

That means the pool is **Raydium CLMM**, not AMM v4.
AMM v4 swap builders need OpenBook market accounts; CLMM does not use them.

This build:
- Adds /raydium-raw so you can see the raw pool object
- Adds /raydium-sdk-exports so we can patch SDK function names if needed
- Supports POST /build-tx with mode=clmm_swap (swap-only) using best-effort CLMM builders

## Configure
POST /config:
{
  "user": {
    "userSourceTokenAccount": "<YOUR USDC ATA>",
    "userDestinationTokenAccount": "<YOUR wSOL ATA>"
  },
  "settings": { "cuLimit": 1600000, "cuPriceMicroLamports": 80000, "requireSimulation": true }
}

## Test
- GET /health
- GET /raydium-raw
- POST /build-tx: { userPublicKey, mode:"clmm_swap", amountIn:1000000, minAmountOut:0 }

If build fails, open /raydium-sdk-exports and paste the exports list + the error.
