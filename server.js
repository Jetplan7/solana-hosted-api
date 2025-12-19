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

const VERSION = "1.6.6-fix24-retry-longtimeout";
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SIMULATE_BUILD = String(process.env.SIMULATE_BUILD || "false").toLowerCase() === "true";
const RAYDIUM_JSON_URL = process.env.RAYDIUM_JSON_URL || "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";
const RAYDIUM_FETCH_TIMEOUT_MS = Number(process.env.RAYDIUM_FETCH_TIMEOUT_MS || 15000);
const RAYDIUM_FETCH_RETRIES = Number(process.env.RAYDIUM_FETCH_RETRIES || 3);

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
const USDC_DECIMALS = 6;

function body(req){ return req.jsonBody || {}; }
function requireStr(v,name){ if(!v || typeof v !== "string") throw new Error(`${name} must be a string`); return v; }
function requireInt(v,name){
  const n = Number(v);
  if(!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}
function toUSDC(rawBig){ return Number(rawBig) / 10**USDC_DECIMALS; }

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
async function simulateOrThrow(tx){
  const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-180);
    throw new Error("Simulation failed: " + JSON.stringify(sim.value.err) + "\n" + logs.join("\n"));
  }
  return sim.value.logs || [];
}
async function finalizeTx(tx, feePayer, doSimulate){
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  if (doSimulate) await simulateOrThrow(tx);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}
async function loadSdk(){
  const mod = await import("@raydium-io/raydium-sdk");
  return mod && (mod.Liquidity || mod.Clmm) ? mod : (mod.default ?? mod);
}

// Fetch with timeout + retry + cache
let AMM_CACHE = { ts: 0, pools: null, src: null };

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchJsonWithTimeout(url, ms){
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchAmmJson(){
  const now = Date.now();
  if (AMM_CACHE.pools && (now - AMM_CACHE.ts) < 5 * 60_000) return AMM_CACHE;

  let lastErr = null;
  for (let attempt = 1; attempt <= RAYDIUM_FETCH_RETRIES; attempt++) {
    try {
      const json = await fetchJsonWithTimeout(RAYDIUM_JSON_URL, RAYDIUM_FETCH_TIMEOUT_MS);
      let pools = [];
      if (Array.isArray(json?.official)) pools = pools.concat(json.official);
      if (Array.isArray(json?.unOfficial)) pools = pools.concat(json.unOfficial);
      if (!pools.length && Array.isArray(json)) pools = json;
      if (!pools.length) throw new Error("Unexpected Raydium v2 sdk json shape");
      AMM_CACHE = { ts: now, pools, src: RAYDIUM_JSON_URL };
      return AMM_CACHE;
    } catch (e) {
      lastErr = e;
      // small backoff
      await sleep(250 * attempt);
    }
  }
  throw new Error(`Raydium fetch failed after ${RAYDIUM_FETCH_RETRIES} tries: ${String(lastErr?.message || lastErr)}`);
}

function pickBestAmm(pools){
  const usdc = USDC_MINT.toBase58(), sol = WSOL_MINT.toBase58();
  const good = pools.filter(p => (p.baseMint===usdc && p.quoteMint===sol) || (p.baseMint===sol && p.quoteMint===usdc));
  if (!good.length) return null;
  good.sort((a,b) => (Number(b.tvl||b.tvlUsd||0) - Number(a.tvl||a.tvlUsd||0)));
  return good[0];
}
function stripToSdkJson(p){
  const keep = [
    "id","baseMint","quoteMint","lpMint","version","programId","authority","openOrders","targetOrders",
    "baseVault","quoteVault","withdrawQueue","lpVault","marketVersion","marketProgramId","marketId",
    "marketAuthority","marketBaseVault","marketQuoteVault","marketBids","marketAsks","marketEventQueue"
  ];
  const out = {};
  for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

async function quoteAmmMinOut({ sdk, poolJson, amountInLamports, slippageBps }){
  try {
    if (!sdk.Liquidity || !sdk.jsonInfo2PoolKeys) return { expectedOutRaw:null, minOutRaw:0n, note:"SDK missing Liquidity/jsonInfo2PoolKeys" };
    const poolKeys = sdk.jsonInfo2PoolKeys(stripToSdkJson(poolJson));
    const poolInfo = await sdk.Liquidity.fetchInfo({ connection, poolKeys });
    if (!sdk.Liquidity.computeAmountOut) return { expectedOutRaw:null, minOutRaw:0n, note:"computeAmountOut missing" };
    const r = sdk.Liquidity.computeAmountOut({ poolKeys, poolInfo, amountIn: amountInLamports, currencyOut: "quote", slippage: 0 });
    const out = r?.amountOut ?? r?.minAmountOut ?? r?.amountOutMin;
    if (out === undefined || out === null) return { expectedOutRaw:null, minOutRaw:0n, note:"computeAmountOut unknown shape" };
    const expectedOutRaw = BigInt(out);
    const minOutRaw = (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
    return { expectedOutRaw, minOutRaw, note:null };
  } catch (e) {
    return { expectedOutRaw:null, minOutRaw:0n, note:String(e?.message || e) };
  }
}

async function buildAmmSwapIxs({ sdk, poolJson, owner, amountInLamports, minAmountOutRaw }){
  if (!sdk.Liquidity) throw new Error("Raydium SDK missing Liquidity module");
  if (!sdk.jsonInfo2PoolKeys) throw new Error("Raydium SDK missing jsonInfo2PoolKeys");

  const poolKeys = sdk.jsonInfo2PoolKeys(stripToSdkJson(poolJson));
  const { usdcAta, wsolAta } = deriveAtas(owner);

  const wsolInfo = await connection.getAccountInfo(wsolAta);
  if (!wsolInfo) throw new Error("WSOL ATA does not exist yet. Run setup first.");

  const r = await sdk.Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: { tokenAccountIn: wsolAta, tokenAccountOut: usdcAta, owner },
    amountIn: amountInLamports,
    amountOut: Number(minAmountOutRaw),
    fixedSide: "in",
    makeTxVersion: 0,
  });

  const inner = r?.innerTransactions || [];
  const ixs = inner.flatMap(tx => tx.instructions || []);
  const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
  if (!finalIxs.length) throw new Error("AMM builder returned no instructions");
  return { ixs: finalIxs, usdcAta, wsolAta, builder: "Liquidity.makeSwapInstructionSimple" };
}

// Routes
app.get("/send", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/send.html", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/", (_req, res) => res.json({ ok:true, version:VERSION, rpc:RPC, simulateBuild:SIMULATE_BUILD, raydium:{ url:RAYDIUM_JSON_URL, timeoutMs:RAYDIUM_FETCH_TIMEOUT_MS, retries:RAYDIUM_FETCH_RETRIES }, endpoints:["/version","/send","/raydium-source","/derive/:wallet","/quote-swap","/build-setup-tx","/build-swap-tx"] }));
app.get("/version", (_req, res) => res.json({ ok:true, version:VERSION }));
app.get("/raydium-source", async (_req, res) => {
  try {
    const c = await fetchAmmJson();
    res.json({ ok:true, version:VERSION, source:c.src, count:c.pools.length, timeoutMs:RAYDIUM_FETCH_TIMEOUT_MS, retries:RAYDIUM_FETCH_RETRIES });
  } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
});
app.get("/derive/:wallet", (req, res) => {
  try {
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok:true, version:VERSION, wallet:owner.toBase58(), usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58() });
  } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.post("/build-setup-tx", async (req, res) => {
  try {
    const b = body(req);
    const user = new PublicKey(requireStr(b.userPublicKey, "userPublicKey"));
    const wrapLamports = requireInt(b.wrapLamports, "wrapLamports");
    if (wrapLamports <= 0) throw new Error("wrapLamports must be > 0");

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
    if (createUsdc) tx.add(createUsdc);
    if (createWsol) tx.add(createWsol);

    tx.add(SystemProgram.transfer({ fromPubkey:user, toPubkey:wsolAta, lamports:wrapLamports }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTx(tx, user, false);
    res.json({ ok:true, version:VERSION, usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58(), wrapLamports, tx:b64 });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.post("/build-swap-tx", async (req, res) => {
  try {
    const b = body(req);
    const user = new PublicKey(requireStr(b.userPublicKey, "userPublicKey"));
    const amountInLamports = requireInt(b.amountInLamports, "amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 30, "slippageBps");
    const closeWsolRequested = !!b.closeWsol;

    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (slippageBps < 0 || slippageBps > 2000) throw new Error("slippageBps must be 0..2000");

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    if (createUsdc) tx.add(createUsdc);

    const c = await fetchAmmJson();
    const amm = pickBestAmm(c.pools);
    if (!amm) throw new Error("No compatible AMM pool found for SOL/USDC in Raydium v2 sdk list.");

    const sdk = await loadSdk();
    const q = await quoteAmmMinOut({ sdk, poolJson: amm, amountInLamports, slippageBps });
    const minOutRaw = q.expectedOutRaw ? q.minOutRaw : 0n;

    const built = await buildAmmSwapIxs({ sdk, poolJson: amm, owner: user, amountInLamports, minAmountOutRaw: minOutRaw });
    for (const ix of built.ixs) tx.add(ix);

    let closeWsolApplied = false;
    if (closeWsolRequested) {
      const wsolInfo = await connection.getAccountInfo(wsolAta);
      if (wsolInfo) {
        tx.add(createCloseAccountInstruction(wsolAta, user, user));
        closeWsolApplied = true;
      }
    }

    const b64 = await finalizeTx(tx, user, SIMULATE_BUILD);

    res.json({
      ok:true, version:VERSION, rpc:RPC, source:c.src, pool:amm.id,
      amountInLamports, slippageBps,
      expectedOutUsdc: q.expectedOutRaw ? toUSDC(q.expectedOutRaw) : null,
      minAmountOutUsdc: q.expectedOutRaw ? toUSDC(minOutRaw) : null,
      closeWsolRequested, closeWsolApplied,
      simulateBuild: SIMULATE_BUILD,
      tx: b64,
      note: SIMULATE_BUILD ? "Built with server-side simulation." : "Built without server-side simulation. Sign+send in Phantom; if it fails, paste on-chain error."
    });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
