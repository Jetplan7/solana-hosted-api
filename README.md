# CLMM auto-ATA fix7

Fixes "invalid public key ... value=\"Concentrated\"" by not passing the raw Raydium API pool object blindly into jsonInfo2PoolKeys.

This build tries multiple "jsonInfo" shapes (full, minimal, stringMints) and reports which one works,
then uses the produced poolKeys in:
  Clmm.fetchMultiplePoolInfos({ poolKeys: [poolKeys] })
