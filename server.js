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

const VERSION = "1.6.2-fix20-quote-swap-close";
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
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }));
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
  return mod && mod.Clmm ? mod : (mod.default ?? mod);
}
async function fetchBestPool(){
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT.toBase58()}&mint2=${WSOL_MINT.toBase58()}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Raydium API HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.data?.data || json?.data?.list || json?.data || json?.result?.data || json?.result || [];
  if (!Array.isArray(list) || !list.length) throw new Error("No pools returned");
  return list[0];
}
function pk(x){
  if (!x) return null;
  try {
    if (x instanceof PublicKey) return x;
    if (typeof x === "string") return new PublicKey(x);
  } catch {}
  return null;
}
async function decodeClmmPoolState(sdk, poolId){
  if (!sdk.PoolInfoLayout?.decode) throw new Error("PoolInfoLayout.decode missing in Raydium SDK");
  const acc = await connection.getAccountInfo(poolId);
  if (!acc?.data) throw new Error("Pool account not found");
  return sdk.PoolInfoLayout.decode(acc.data);
}

function toUSDC(nBig){
  // nBig bigint (raw units)
  const n = Number(nBig);
  return n / 10**USDC_DECIMALS;
}

async function buildContextForClmm(owner){
  const sdk = await loadSdk();
  const apiPool = await fetchBestPool();
  if (String(apiPool.type).toLowerCase() !== "concentrated") throw new Error(`Expected CLMM pool but got: ${apiPool.type}`);
  const poolId = new PublicKey(apiPool.id);
  const decoded = await decodeClmmPoolState(sdk, poolId);

  const poolInfo = { ...decoded };
  poolInfo.id = poolId;
  poolInfo.programId = new PublicKey(apiPool.programId);

  // normalize common pubkeys
  for (const k of ["ammConfig","mintA","mintB","vaultA","vaultB","observationId","tickArrayBitmap"]) {
    const p = pk(poolInfo[k]);
    if (p) poolInfo[k] = p;
  }
  // poolKeys (full-ish)
  const poolKeys = {
    id: poolId,
    programId: poolInfo.programId,
    ammConfigId: pk(poolInfo.ammConfig) || pk(poolInfo.ammConfigId),
    mintA: pk(poolInfo.mintA),
    mintB: pk(poolInfo.mintB),
    vaultA: pk(poolInfo.vaultA),
    vaultB: pk(poolInfo.vaultB),
    observationId: pk(poolInfo.observationId),
    tickArrayBitmap: pk(poolInfo.tickArrayBitmap),
  };
  // optional ex bitmap pda
  try {
    if (sdk.getPdaExBitmapAccount) {
      const ex = sdk.getPdaExBitmapAccount(poolId);
      if (ex?.publicKey) poolKeys.exBitmapAccount = ex.publicKey;
      else if (ex?.key) poolKeys.exBitmapAccount = ex.key;
    }
  } catch {}

  const { usdcAta, wsolAta } = deriveAtas(owner);
  return { sdk, apiPool, poolId, poolInfo, poolKeys, usdcAta, wsolAta };
}

async function quoteSwapBaseIn({ owner, amountInLamports }){
  const { sdk, poolId, poolInfo, poolKeys } = await buildContextForClmm(owner);

  if (!sdk.Clmm?.computeAmountOut) throw new Error("Clmm.computeAmountOut missing in SDK");
  // Raydium CLMM compute typically needs direction by mintIn/mintOut
  const mintIn = WSOL_MINT;
  const mintOut = USDC_MINT;

  const r = await sdk.Clmm.computeAmountOut({
    poolInfo,
    poolKeys,
    amountIn: BigInt(amountInLamports),
    mintIn,
    mintOut,
    slippage: 0, // we compute min-out ourselves
  });

  // try to find amountOut in return shape
  const amountOut = r?.amountOut ?? r?.expectedAmountOut ?? r?.amountOutMin ?? r?.minAmountOut;
  if (amountOut === undefined || amountOut === null) {
    throw new Error("computeAmountOut returned unknown shape");
  }
  return { poolId, amountOutRaw: BigInt(amountOut) };
}

async function buildClmmSwapIxs({ owner, amountInLamports, minAmountOutUsdc }){
  const { sdk, apiPool, poolId, poolInfo, poolKeys, usdcAta, wsolAta } = await buildContextForClmm(owner);

  const wsolInfo = await connection.getAccountInfo(wsolAta);
  if (!wsolInfo) throw new Error("WSOL ATA does not exist yet. Run setup first.");

  const ownerInfo = { wallet: owner, tokenAccountIn: wsolAta, tokenAccountOut: usdcAta };
  const amountIn = BigInt(amountInLamports);
  const amountOutMin = BigInt(minAmountOutUsdc);

  const tryFns = [];
  if (sdk.Clmm?.makeSwapBaseInInstructionSimple) tryFns.push({ name: "makeSwapBaseInInstructionSimple", fn: sdk.Clmm.makeSwapBaseInInstructionSimple });
  if (sdk.Clmm?.makeSwapBaseInInstructions) tryFns.push({ name: "makeSwapBaseInInstructions", fn: sdk.Clmm.makeSwapBaseInInstructions });

  const attempts = [];
  for (const t of tryFns) {
    try {
      const r = await t.fn({ connection, poolInfo, poolKeys, ownerInfo, amountIn, amountOutMin });
      const inner = r?.innerTransactions || [];
      const ixs = inner.flatMap(tx => tx.instructions || []);
      const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
      if (!finalIxs.length) throw new Error("builder returned no instructions");
      return { ixs: finalIxs, builder: t.name, poolId, poolType: apiPool.type, poolProgramId: apiPool.programId, usdcAta, wsolAta };
    } catch (e) {
      attempts.push({ name: t.name, err: String(e?.message || e) });
    }
  }
  throw new Error("Raydium CLMM builder failed: " + JSON.stringify({ attempts }, null, 2));
}

// Pages + info
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

// Quote
app.post("/quote-swap", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const amountInLamports = requireInt(b.amountInLamports, "amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 50, "slippageBps"); // default 0.50%
    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (slippageBps < 0 || slippageBps > 2000) throw new Error("slippageBps must be 0..2000");

    const user = new PublicKey(userPublicKey);
    const q = await quoteSwapBaseIn({ owner:user, amountInLamports });
    const expectedOutUsdc = toUSDC(q.amountOutRaw);
    const minRaw = (q.amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
    const minOutUsdc = toUSDC(minRaw);

    res.json({ ok:true, version:VERSION, pool:q.poolId.toBase58(), amountInLamports, expectedOutRaw: q.amountOutRaw.toString(), expectedOutUsdc, slippageBps, minOutRaw: minRaw.toString(), minOutUsdc });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

// Setup
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

// Swap
app.post("/build-swap-tx", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const amountInLamports = requireInt(b.amountInLamports, "amountInLamports");
    const slippageBps = requireInt(b.slippageBps ?? 50, "slippageBps");
    const closeWsolRequested = !!b.closeWsol;

    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (slippageBps < 0 || slippageBps > 2000) throw new Error("slippageBps must be 0..2000");

    const user = new PublicKey(userPublicKey);
    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);

    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    if (createUsdc) tx.add(createUsdc);

    // Quote to compute min-out
    const q = await quoteSwapBaseIn({ owner:user, amountInLamports });
    const minRaw = (q.amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

    const built = await buildClmmSwapIxs({ owner:user, amountInLamports, minAmountOutUsdc: Number(minRaw) });
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
      builder: built.builder,
      pool: built.poolId.toBase58(),
      poolType: built.poolType,
      usdcAta: built.usdcAta.toBase58(),
      wsolAta: built.wsolAta.toBase58(),
      amountInLamports,
      expectedOutUsdc: toUSDC(q.amountOutRaw),
      minAmountOutUsdc: toUSDC(minRaw),
      slippageBps,
      closeWsolRequested,
      closeWsolApplied,
      tx: b64,
      note: "Swap built after quoting; server simulates before returning. Min-out uses slippageBps."
    });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
