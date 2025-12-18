# CLMM auto-ATA diag v2

Fixes two issues:
- Raydium SDK sometimes exports everything under `default` when imported as ESM
- CLMM fetchers accept different parameter shapes; we try multiple conventions

New endpoint:
- GET /sdk-shape  -> shows actual SDK shape on Render (top-level vs default), and Clmm methods list
