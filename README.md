# CLMM auto-ATA fix5

Adds /try-fetch endpoint to discover the correct parameter shape for:
Clmm.fetchMultiplePoolInfos on your specific Raydium SDK build.

After deploy:
- Open /version (should be 1.4.6-fix5)
- Open /try-fetch and paste the JSON here (it tells us which variant works)
- Then /build-tx will use the working variant automatically.
