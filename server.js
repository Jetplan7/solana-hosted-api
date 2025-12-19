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

const VERSION = "1.6.3-fix21-ammv4-fallback";
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
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }));
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

function toUSDC(rawBig){
  const n = Number(rawBig);
  return n / 10**USDC_DECIMALS;
}

// --- Pool selection ---
async function fetchPools(){
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT.toBase58()}&mint2=${WSOL_MINT.toBase58()}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=50&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Raydium API HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.data?.data || json?.data?.list || json?.data || json?.result?.data || json?.result || [];
  if (!Array.isArray(list) || !list.length) return [];
  return list;
}
function isConcentrated(p){ return String(p?.type || "").toLowerCase().includes("concentrated"); }
function bestAmmPool(pools){
  // Prefer non-CLMM pools. If multiple, pick highest tvl if present.
  const amm = pools.filter(p => !isConcentrated(p));
  if (!amm.length) return null;
  amm.sort((a,b) => (Number(b.tvl||0) - Number(a.tvl||0)));
  return amm[0];
}

// --- AMM v4 swap build ---
async function quoteAmm({ sdk, poolJson, amountInLamports }){
  // Try to compute expected out using Liquidity.fetchInfo + computeAmountOut
  if (!sdk.Liquidity) throw new Error("Raydium SDK missing Liquidity module");
  const poolKeys = sdk.jsonInfo2PoolKeys ? sdk.jsonInfo2PoolKeys(poolJson) : null;
  if (!poolKeys) throw new Error("jsonInfo2PoolKeys not available");
  // Fetch on-chain pool info
  const poolInfo = await sdk.Liquidity.fetchInfo({ connection, poolKeys });
  // base-in: WSOL -> USDC
  const amountIn = amountInLamports;
  const { amountOut } = sdk.Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: poolKeys.quoteMint?.equals?.(USDC_MINT) ? "quote" : "base",
    slippage: 0,
  });
  return { poolKeys, poolInfo, amountOutRaw: BigInt(amountOut) };
}

async function buildAmmSwapIxs({ sdk, poolJson, owner, amountInLamports, minAmountOutRaw }){
  if (!sdk.Liquidity) throw new Error("Raydium SDK missing Liquidity module");
  if (!sdk.jsonInfo2PoolKeys) throw new Error("Raydium SDK missing jsonInfo2PoolKeys");
  const poolKeys = sdk.jsonInfo2PoolKeys(poolJson);

  const { usdcAta, wsolAta } = deriveAtas(owner);
  const wsolInfo = await connection.getAccountInfo(wsolAta);
  if (!wsolInfo) throw new Error("WSOL ATA does not exist yet. Run setup first.");

  // Build swap instruction set
  const r = await sdk.Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys: {
      tokenAccountIn: wsolAta,
      tokenAccountOut: usdcAta,
      owner,
    },
    amountIn: amountInLamports,
    amountOut: Number(minAmountOutRaw),
    fixedSide: "in",
    makeTxVersion: 0,
  });
  const inner = r?.innerTransactions || [];
  const ixs = inner.flatMap(tx => tx.instructions || []);
  const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
  if (!finalIxs.length) throw new Error("AMM builder returned no instructions");
  return { ixs: finalIxs, poolKeys, usdcAta, wsolAta, builder: "Liquidity.makeSwapInstructionSimple" };
}

// Routes
app.get("/send", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/send.html", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/", (_req, res) => res.json({ ok:true, version:VERSION, endpoints:["/version","/send","/derive/:wallet","/quote-swap","/build-setup-tx","/build-swap-tx"] }));
app.get("/version", (_req, res) => res.json({ ok:true, version:VERSION }));
app.get("/derive/:wallet", (req, res) => {
  try {
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok:true, version:VERSION, wallet:owner.toBase58(), usdcMint:USDC_MINT.toBase58(), wsolMint:WSOL_MINT.toBase58(), usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58() });
  } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.post("/quote-swap", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const amountInLamports = requireInt(b.amountInLamports, "amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 30, "slippageBps");
    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (slippageBps < 0 || slippageBps > 2000) throw new Error("slippageBps must be 0..2000");

    const user = new PublicKey(userPublicKey);
    const pools = await fetchPools();
    const amm = bestAmmPool(pools);
    if (!amm) {
      throw new Error("Raydium API returned only CLMM (Concentrated) pools for SOL/USDC. This build uses AMM v4 for reliability. Try again later or switch pool selection.");
    }
    const sdk = await loadSdk();

    // Compute expected out. If compute fails due to SDK shape, still return pool selection.
    let expectedOutRaw = null;
    let expectedOutUsdc = null;
    try {
      const q = await quoteAmm({ sdk, poolJson: amm, amountInLamports });
      expectedOutRaw = q.amountOutRaw.toString();
      expectedOutUsdc = toUSDC(q.amountOutRaw);
    } catch (e) {
      expectedOutRaw = null;
      expectedOutUsdc = null;
    }

    if (expectedOutRaw) {
      const minRaw = (BigInt(expectedOutRaw) * BigInt(10_000 - slippageBps)) / 10_000n;
      res.json({ ok:true, version:VERSION, poolType:amm.type, pool:amm.id, amountInLamports, expectedOutRaw, expectedOutUsdc, slippageBps, minOutRaw:minRaw.toString(), minOutUsdc:toUSDC(minRaw) });
    } else {
      res.json({ ok:true, version:VERSION, poolType:amm.type, pool:amm.id, amountInLamports, expectedOutRaw:null, expectedOutUsdc:null, slippageBps, note:"Quote compute unavailable in this SDK build; swap will still use slippageBps with minOut=0 unless compute succeeds during build." });
    }
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.post("/build-setup-tx", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const wrapLamports = requireInt(b.wrapLamports, "wrapLamports");
    if (wrapLamports <= 0) throw new Error("wrapLamports must be > 0");
    const user = new PublicKey(userPublicKey);

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
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const amountInLamports = requireInt(b.amountInLamports, "amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 30, "slippageBps");
    const closeWsolRequested = !!b.closeWsol;

    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (slippageBps < 0 || slippageBps > 2000) throw new Error("slippageBps must be 0..2000");

    const user = new PublicKey(userPublicKey);
    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    if (createUsdc) tx.add(createUsdc);

    const pools = await fetchPools();
    const amm = bestAmmPool(pools);
    if (!amm) {
      throw new Error("Raydium API returned only CLMM (Concentrated) pools for SOL/USDC. This build uses AMM v4 for reliability. (CLMM tick-array routing not enabled in this build.)");
    }
    const sdk = await loadSdk();

    // Try quote for min-out; if quote fails, min-out=0 (still safe-ish with small test trades)
    let expectedOutRaw = null;
    let expectedOutUsdc = null;
    let minOutRaw = 0n;
    try {
      const q = await quoteAmm({ sdk, poolJson: amm, amountInLamports });
      expectedOutRaw = q.amountOutRaw;
      expectedOutUsdc = toUSDC(q.amountOutRaw);
      minOutRaw = (q.amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
    } catch (e) {
      expectedOutRaw = null;
      expectedOutUsdc = null;
      minOutRaw = 0n;
    }

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

    const b64 = await finalizeTx(tx, user, true);
    res.json({
      ok:true,
      version:VERSION,
      poolType: amm.type,
      pool: amm.id,
      builder: built.builder,
      amountInLamports,
      expectedOutUsdc: expectedOutRaw ? expectedOutUsdc : null,
      minAmountOutUsdc: expectedOutRaw ? toUSDC(minOutRaw) : null,
      slippageBps,
      closeWsolRequested,
      closeWsolApplied,
      tx: b64,
      note: expectedOutRaw ? "Min-out computed from on-chain quote." : "Min-out is 0 because quote compute failed in this SDK build; keep trades small."
    });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
