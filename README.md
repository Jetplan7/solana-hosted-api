# Fix: Raydium auto-pool was picking CLMM (Concentrated)

Your /raydium-raw output shows:
- type: "Concentrated"
- programId: CAMMC... (Raydium CLMM)

But the Raydium `Liquidity.makeSwapInstructionSimple` builder is for AMM v4 pools,
which have OpenBook market fields like marketId/marketBids/etc.

This build:
- fetches multiple pools from Raydium API
- filters out CLMM
- picks the best compatible AMM v4 pool
- supports mode=raydium_swap (swap-only) to confirm pool selection works

## After deploy
- GET /raydium-pool  -> should return a pool object with fields authority/openOrders/marketId/etc (not "Concentrated")
- POST /build-tx with mode=raydium_swap to confirm instruction building works.

Once swap-only works, we re-enable the Solend flashloan path on top.
