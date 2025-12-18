# Railway Deployment (Backend API)

This backend is meant to be deployed on Railway and called from your one-page Trust Wallet (WalletConnect) HTML.

## Endpoints
- GET  /health
- POST /build-tx   { userPublicKey, amount }
- POST /send-signed { signedTxBase64 }

## Deploy on Railway (no CLI required)
1) Create a new GitHub repo and upload these files.
2) In Railway:
   - New Project → Deploy from GitHub Repo → select your repo
3) Variables (Railway → Variables):
   - SOLANA_RPC = https://api.mainnet-beta.solana.com   (or your private RPC)
4) Railway will set PORT automatically.

## Test
After deploy, your Railway service URL will look like:
https://your-service.up.railway.app

Open:
https://your-service.up.railway.app/health

You should get JSON with blockHeight.

## Next
Replace the no-op instruction in server.js with your real instruction builders.
