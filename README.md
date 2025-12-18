# CLMM auto-ATA + diagnostics build

This build improves CLMM swap building by attempting to fetch full pool info from RPC before building swap,
and returns rich diagnostics if it still fails.

Endpoints:
- GET /clmm-methods
- GET /derive/:wallet
- POST /build-tx (mode=clmm_swap)
