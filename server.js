const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const { Connection, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction
} = require("@solana/spl-token");

dotenv.config();

const VERSION = "1.6.7-fix25-jupiter-fallback";
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SIMULATE_BUILD = String(process.env.SIMULATE_BUILD || "false").toLowerCase() === "true";
const USE_JUPITER_FALLBACK = String(process.env.USE_JUPITER_FALLBACK || "true").toLowerCase() === "true";

const JUPITER_QUOTE_URL = process.env.JUPITER_QUOTE_URL || "https://quote-api.jup.ag/v6/quote";
const JUPITER_SWAP_URL = process.env.JUPITER_SWAP_URL || "https://quote-api.jup.ag/v6/swap";

const RAYDIUM_JSON_URL = process.env.RAYDIUM_JSON_URL || "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const RAYDIUM_FETCH_TIMEOUT_MS = Number(process.env.RAYDIUM_FETCH_TIMEOUT_MS || 15000);
const RAYDIUM_FETCH_RETRIES = Number(process.env.RAYDIUM_FETCH_RETRIES || 2);

const connection = new Connection(RPC, "confirmed");

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use((req, _res, next) => {
  if (["POST","PUT","PATCH"].includes(req.method)) {
    const raw = typeof req.body === "string" ? req.body : "";
    req.rawBody = raw;
    if (raw && raw.trim().length) {
      try { req.jsonBody = JSON.parse(raw); }
      catch (e) { req.jsonBody = null; req.jsonError = String(e?.message || e); }
    } else req.jsonBody = null;
  }
  next();
});

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

function body(req){ return req.jsonBody || {}; }
function requireStr(v,name){ if(!v || typeof v !== "string") throw new Error(`${name} must be a string`); return v; }
function requireInt(v,name){
  const n = Number(v);
  if(!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function deriveAtas(owner){
  return {
    usdcAta: getAssociatedTokenAddressSync(USDC_MINT, owner, false),
    wsolAta: getAssociatedTokenAddressSync(WSOL_MINT, owner, false),
  };
}
async function ensureAtaIx(payerOwner, ata, mint){
  const info = await connection.getAccountInfo(ata);
  if (info) return null;
  return createAssociatedTokenAccountInstruction(payerOwner, ata, payerOwner, mint);
}
function addCompute(tx){
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
}
async function finalizeTx(tx, feePayer){
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

// Raydium fetch (can be blocked on Render)
let AMM_CACHE = { ts: 0, pools: null, src: null };
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function fetchJsonWithTimeout(url, ms){
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
async function fetchAmmJson(){
  const now = Date.now();
  if (AMM_CACHE.pools && (now - AMM_CACHE.ts) < 10 * 60_000) return AMM_CACHE;
  let lastErr = null;
  for (let i=1;i<=RAYDIUM_FETCH_RETRIES;i++){
    try{
      const json = await fetchJsonWithTimeout(RAYDIUM_JSON_URL, RAYDIUM_FETCH_TIMEOUT_MS);
      let pools=[];
      if (Array.isArray(json?.official)) pools=pools.concat(json.official);
      if (Array.isArray(json?.unOfficial)) pools=pools.concat(json.unOfficial);
      if (!pools.length && Array.isArray(json)) pools=json;
      if (!pools.length) throw new Error("Unexpected Raydium v2 sdk json shape");
      AMM_CACHE={ ts: now, pools, src: RAYDIUM_JSON_URL };
      return AMM_CACHE;
    }catch(e){ lastErr=e; await sleep(250*i); }
  }
  throw new Error(`Raydium fetch failed after ${RAYDIUM_FETCH_RETRIES} tries: ${String(lastErr?.message||lastErr)}`);
}
function pickBestAmm(pools){
  const usdc = USDC_MINT.toBase58(), sol = WSOL_MINT.toBase58();
  const good = pools.filter(p => (p.baseMint===usdc && p.quoteMint===sol) || (p.baseMint===sol && p.quoteMint===usdc));
  if (!good.length) return null;
  good.sort((a,b)=> (Number(b.tvl||b.tvlUsd||0)-Number(a.tvl||a.tvlUsd||0)));
  return good[0];
}

// Jupiter swap builder (reliable, no Raydium list needed)
async function jupiterBuildSwapTx({ userPublicKey, amountInLamports, slippageBps }){
  const inputMint = WSOL_MINT.toBase58();
  const outputMint = USDC_MINT.toBase58();

  const qUrl = new URL(JUPITER_QUOTE_URL);
  qUrl.searchParams.set("inputMint", inputMint);
  qUrl.searchParams.set("outputMint", outputMint);
  qUrl.searchParams.set("amount", String(amountInLamports));
  qUrl.searchParams.set("slippageBps", String(slippageBps));
  qUrl.searchParams.set("onlyDirectRoutes", "false");

  const qRes = await fetch(qUrl.toString(), { headers: { accept: "application/json" } });
  if (!qRes.ok) throw new Error(`Jupiter quote HTTP ${qRes.status}`);
  const quote = await qRes.json();
  const route = quote?.data?.[0];
  if (!route) throw new Error("Jupiter quote returned no routes");

  const sRes = await fetch(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "Content-Type":"application/json", accept:"application/json" },
    body: JSON.stringify({
      quoteResponse: route,
      userPublicKey,
      wrapAndUnwrapSol: false, // we handle WSOL separately with setup
      dynamicComputeUnitLimit: true
    })
  });
  if (!sRes.ok) {
    const t = await sRes.text();
    throw new Error(`Jupiter swap HTTP ${sRes.status}: ${t.slice(0,200)}`);
  }
  const swap = await sRes.json();
  const tx = swap?.swapTransaction;
  if (!tx) throw new Error("Jupiter swap response missing swapTransaction");
  return { tx, routeSummary: { outAmount: route.outAmount, priceImpactPct: route.priceImpactPct, marketInfosCount: (route.marketInfos||[]).length } };
}

// Routes
app.get("/send", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/version", (_req,res)=>res.json({ ok:true, version:VERSION, rpc:RPC, useJupiterFallback:USE_JUPITER_FALLBACK }));
app.get("/", (_req,res)=>res.json({
  ok:true, version:VERSION, rpc:RPC,
  endpoints:["/version","/send","/raydium-source","/derive/:wallet","/build-setup-tx","/build-swap-tx"],
  raydium:{ url:RAYDIUM_JSON_URL, timeoutMs:RAYDIUM_FETCH_TIMEOUT_MS, retries:RAYDIUM_FETCH_RETRIES },
  jupiter:{ quote:JUPITER_QUOTE_URL, swap:JUPITER_SWAP_URL }
}));
app.get("/raydium-source", async (_req,res)=>{
  try{
    const c = await fetchAmmJson();
    res.json({ ok:true, version:VERSION, source:c.src, count:c.pools.length });
  }catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});
app.get("/derive/:wallet", (req,res)=>{
  try{
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok:true, version:VERSION, wallet:owner.toBase58(), usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58() });
  }catch(e){ res.status(400).json({ ok:false, error:e.message }); }
});

app.post("/build-setup-tx", async (req,res)=>{
  try{
    const b = body(req);
    const user = new PublicKey(requireStr(b.userPublicKey,"userPublicKey"));
    const wrapLamports = requireInt(b.wrapLamports,"wrapLamports");
    if (wrapLamports<=0) throw new Error("wrapLamports must be > 0");

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
    if (createUsdc) tx.add(createUsdc);
    if (createWsol) tx.add(createWsol);

    tx.add(SystemProgram.transfer({ fromPubkey:user, toPubkey:wsolAta, lamports:wrapLamports }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTx(tx, user);
    res.json({ ok:true, version:VERSION, usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58(), wrapLamports, tx:b64 });
  }catch(e){
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.post("/build-swap-tx", async (req,res)=>{
  try{
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey,"userPublicKey");
    const user = new PublicKey(userPublicKey);
    const amountInLamports = requireInt(b.amountInLamports,"amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 30, "slippageBps");
    const closeWsolRequested = !!b.closeWsol;

    if (amountInLamports<=0) throw new Error("amountInLamports must be > 0");

    // First try Raydium list; if it aborts and fallback enabled, use Jupiter tx builder.
    let raydiumErr = null;
    try{
      const c = await fetchAmmJson();
      const amm = pickBestAmm(c.pools);
      if (!amm) throw new Error("No SOL/USDC AMM in Raydium v2 list");
      // If we got here, we at least have list. We still might prefer Jupiter due to SDK variability.
      if (!USE_JUPITER_FALLBACK) throw new Error("Raydium SDK build not implemented in fix25; enable USE_JUPITER_FALLBACK");
    }catch(e){ raydiumErr = String(e?.message||e); }

    if (!USE_JUPITER_FALLBACK) throw new Error("Raydium fetch/build failed and Jupiter fallback disabled: " + raydiumErr);

    const j = await jupiterBuildSwapTx({ userPublicKey, amountInLamports, slippageBps });

    // Note: Jupiter tx is already fully built; closeWSOL is not applied here.
    res.json({
      ok:true, version:VERSION, builder:"jupiter-v6", rpc:RPC,
      amountInLamports, slippageBps,
      closeWsolRequested, closeWsolApplied:false,
      tx: j.tx,
      routeSummary: j.routeSummary,
      note: "Swap transaction built by Jupiter API (reliable). Sign+send in Phantom. If it fails, paste the on-chain error."
    });
  }catch(e){
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
