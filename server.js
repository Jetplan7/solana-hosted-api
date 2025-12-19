const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction } = require("@solana/spl-token");

dotenv.config();

const VERSION = "1.5.8-fix16-sendpage-setup-nosim";
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC, "confirmed");

app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use((req, _res, next) => {
  if (["POST","PUT","PATCH"].includes(req.method)) {
    const raw = typeof req.body === "string" ? req.body : "";
    req.rawBody = raw;
    if (raw && raw.trim().length) {
      try { req.jsonBody = JSON.parse(raw); }
      catch (e) { req.jsonBody = null; req.jsonError = String(e && e.message ? e.message : e); }
    } else {
      req.jsonBody = null;
    }
  }
  next();
});

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function body(req) { return req.jsonBody || {}; }
function requireStr(v, name) { if (!v || typeof v !== "string") throw new Error(`${name} must be a string`); return v; }
function requireNum(v, name) { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; }

function deriveAtas(owner) {
  return {
    usdcAta: getAssociatedTokenAddressSync(USDC_MINT, owner, false),
    wsolAta: getAssociatedTokenAddressSync(WSOL_MINT, owner, false),
  };
}
async function ensureAtaIx(payerOwner, ata, mint) {
  const info = await connection.getAccountInfo(ata);
  if (info) return null;
  return createAssociatedTokenAccountInstruction(payerOwner, ata, payerOwner, mint);
}
function addCompute(tx) {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }));
}
async function finalizeTxNoSim(tx, feePayer) {
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

app.get("/send", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/send.html", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));

app.get("/", (_req, res) => res.json({ ok: true, version: VERSION, endpoints: ["/version","/send","/derive/:wallet","/build-setup-tx"] }));
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

app.get("/derive/:wallet", (req, res) => {
  try {
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok: true, version: VERSION, wallet: owner.toBase58(), usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58(), usdcMint: USDC_MINT.toBase58(), wsolMint: WSOL_MINT.toBase58() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/build-setup-tx", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const wrapLamports = requireNum(b.wrapLamports, "wrapLamports");
    if (wrapLamports <= 0) throw new Error("wrapLamports must be > 0");

    const user = new PublicKey(userPublicKey);

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
    if (createUsdc) tx.add(createUsdc);
    if (createWsol) tx.add(createWsol);

    tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: Math.trunc(wrapLamports) }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTxNoSim(tx, user);
    res.json({ ok: true, version: VERSION, usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58(), wrapLamports: Math.trunc(wrapLamports), tx: b64 });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, debug: { rawBody: req.rawBody || "", jsonError: req.jsonError || null, parsedBody: req.jsonBody || null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
