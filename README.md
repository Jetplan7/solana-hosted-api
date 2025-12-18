# CLMM auto-ATA fix6

Your /try-fetch showed:
- fetchMultiplePoolInfos expects `poolKeys` (it does poolKeys.map internally)
- Our earlier poolKeys were the wrong shape, causing `_bn` errors

This build uses Raydium SDK's `jsonInfo2PoolKeys(apiPool)` to convert the Raydium API pool JSON into the
correct `poolKeys` struct (PublicKeys, BN values, etc).

Then it calls:
  Clmm.fetchMultiplePoolInfos({ poolKeys: [poolKeys] })

After deploy:
- GET /version => 1.4.7-fix6
- GET /try-fetch => fetchOk should be true
- POST /build-tx => should return ok:true + base64 tx
