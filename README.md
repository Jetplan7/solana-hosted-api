# CLMM auto-ATA fix4 (stops using poolKeys:{id})

Your last error shows the server is STILL attempting:
  fetchMultiplePoolInfos(poolKeys:{id})
which triggers "_bn" error on your instance.

This build removes that variant entirely and adds:
- GET /version to prove which code is deployed
- /health now returns {version: "..."} too

After deploy:
- Open /version and confirm "1.4.5-fix4"
- Then retry POST /build-tx
