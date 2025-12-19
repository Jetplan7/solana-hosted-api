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

const VERSION = "1.6.1-fix19-clmm-poolkeys-full";
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

function body(req){ return req.jsonBody || {}; }
function requireStr(v,name){ if(!v || typeof v !== "string") throw new Error(`${name} must be a string`); return v; }
function requireNum(v,name){ const n = Number(v); if(!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; }

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
    if (x.length === 32) return new PublicKey(x);
  } catch {}
  return null;
}

async function decodeClmmPoolState(sdk, poolId){
  if (!sdk.PoolInfoLayout?.decode) throw new Error("PoolInfoLayout.decode missing in Raydium SDK");
  const acc = await connection.getAccountInfo(poolId);
  if (!acc?.data) throw new Error("Pool account not found");
  return sdk.PoolInfoLayout.decode(acc.data);
}

function pickPkField(obj, key) {
  const v = obj?.[key];
  const p = pk(v);
  return p || null;
}

function describePk(v){
  if (!v) return { ok:false, reason:"undefined/null" };
  try {
    const p = pk(v);
    if (!p) return { ok:false, reason:`type=${typeof v} ctor=${v?.constructor?.name || "?"}` };
    return { ok:true, base58:p.toBase58(), ctor:p.constructor.name };
  } catch (e) {
    return { ok:false, reason:String(e?.message || e) };
  }
}

async function buildClmmSwapIxs({ owner, amountInLamports, minAmountOutUsdc }){
  const sdk = await loadSdk();
  const apiPool = await fetchBestPool();
  if (String(apiPool.type).toLowerCase() !== "concentrated") throw new Error(`Expected CLMM pool but got: ${apiPool.type}`);

  const poolId = new PublicKey(apiPool.id);
  const decoded = await decodeClmmPoolState(sdk, poolId);

  const { usdcAta, wsolAta } = deriveAtas(owner);
  const wsolInfo = await connection.getAccountInfo(wsolAta);
  if (!wsolInfo) throw new Error("WSOL ATA does not exist yet. Run setup first.");

  // Normalize pubkeys in poolInfo
  const poolInfo = { ...decoded };
  poolInfo.id = poolId;
  poolInfo.programId = new PublicKey(apiPool.programId);

  const ammConfig = pickPkField(poolInfo, "ammConfig") || pickPkField(poolInfo, "ammConfigId") || null;
  const mintA = pickPkField(poolInfo, "mintA") || null;
  const mintB = pickPkField(poolInfo, "mintB") || null;
  const vaultA = pickPkField(poolInfo, "vaultA") || null;
  const vaultB = pickPkField(poolInfo, "vaultB") || null;
  const observationId = pickPkField(poolInfo, "observationId") || null;
  const tickArrayBitmap = pickPkField(poolInfo, "tickArrayBitmap") || null;

  if (ammConfig) poolInfo.ammConfig = ammConfig;
  if (mintA) poolInfo.mintA = mintA;
  if (mintB) poolInfo.mintB = mintB;
  if (vaultA) poolInfo.vaultA = vaultA;
  if (vaultB) poolInfo.vaultB = vaultB;
  if (observationId) poolInfo.observationId = observationId;
  if (tickArrayBitmap) poolInfo.tickArrayBitmap = tickArrayBitmap;

  // Build a "full" poolKeys object CLMM builders expect
  const poolKeys = {
    id: poolId,
    programId: poolInfo.programId,
    ammConfigId: ammConfig || undefined,
    mintA: mintA || undefined,
    mintB: mintB || undefined,
    vaultA: vaultA || undefined,
    vaultB: vaultB || undefined,
    observationId: observationId || undefined,
    tickArrayBitmap: tickArrayBitmap || undefined,
  };

  // Some SDK versions use bitmap extension PDA
  try {
    if (sdk.getPdaExBitmapAccount) {
      const ex = sdk.getPdaExBitmapAccount(poolId);
      if (ex?.publicKey) poolKeys.exBitmapAccount = ex.publicKey;
      else if (ex?.key) poolKeys.exBitmapAccount = ex.key;
    }
  } catch {}

  const ownerInfo = { wallet: owner, tokenAccountIn: wsolAta, tokenAccountOut: usdcAta };
  const amountIn = BigInt(amountInLamports);
  const amountOutMin = BigInt(minAmountOutUsdc);

  // Prefer "Simple" builder if present (usually fewer required fields)
  const tryFns = [];
  if (sdk.Clmm?.makeSwapBaseInInstructionSimple) tryFns.push({ name: "makeSwapBaseInInstructionSimple", fn: sdk.Clmm.makeSwapBaseInInstructionSimple });
  if (sdk.Clmm?.makeSwapBaseInInstructions) tryFns.push({ name: "makeSwapBaseInInstructions", fn: sdk.Clmm.makeSwapBaseInInstructions });

  const attempts = [];
  for (const t of tryFns) {
    try {
      const r = await t.fn({
        connection,
        poolInfo,
        poolKeys,
        ownerInfo,
        amountIn,
        amountOutMin,
      });
      const inner = r?.innerTransactions || [];
      const ixs = inner.flatMap(tx => tx.instructions || []);
      const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
      if (!finalIxs.length) throw new Error("builder returned no instructions");
      return { ixs: finalIxs, poolId, poolType: apiPool.type, poolProgramId: apiPool.programId, usdcAta, wsolAta, builder: t.name, attempts };
    } catch (e) {
      attempts.push({ name: t.name, err: String(e?.message || e) });
    }
  }

  const diag = {
    owner: owner.toBase58(),
    poolId: poolId.toBase58(),
    poolProgramId: String(apiPool.programId),
    poolType: String(apiPool.type),
    builderAttempts: attempts,
    poolKeys: Object.fromEntries(Object.entries(poolKeys).map(([k,v]) => [k, v?.toBase58 ? v.toBase58() : v])),
    poolInfoFields: {
      programId: describePk(poolInfo.programId),
      ammConfig: describePk(poolInfo.ammConfig),
      tickArrayBitmap: describePk(poolInfo.tickArrayBitmap),
      mintA: describePk(poolInfo.mintA),
      mintB: describePk(poolInfo.mintB),
      vaultA: describePk(poolInfo.vaultA),
      vaultB: describePk(poolInfo.vaultB),
      observationId: describePk(poolInfo.observationId),
    },
    ownerInfo: { tokenAccountIn: wsolAta.toBase58(), tokenAccountOut: usdcAta.toBase58() },
  };
  throw new Error("Raydium CLMM builder failed after poolKeys fill: " + JSON.stringify(diag, null, 2));
}

// Routes
app.get("/send", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/send.html", (_req, res) => res.sendFile(path.join(__dirname, "send.html")));
app.get("/", (_req, res) => res.json({ ok:true, version:VERSION, endpoints:["/version","/send","/derive/:wallet","/build-setup-tx","/build-swap-tx"] }));
app.get("/version", (_req, res) => res.json({ ok:true, version:VERSION }));

app.get("/derive/:wallet", (req, res) => {
  try {
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok:true, version:VERSION, wallet:owner.toBase58(), usdcMint:USDC_MINT.toBase58(), wsolMint:WSOL_MINT.toBase58(), usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58() });
  } catch (e) { res.status(400).json({ ok:false, error:e.message }); }
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

    tx.add(SystemProgram.transfer({ fromPubkey:user, toPubkey:wsolAta, lamports:Math.trunc(wrapLamports) }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTx(tx, user, false);
    res.json({ ok:true, version:VERSION, usdcAta:usdcAta.toBase58(), wsolAta:wsolAta.toBase58(), wrapLamports:Math.trunc(wrapLamports), tx:b64 });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.post("/build-swap-tx", async (req, res) => {
  try {
    const b = body(req);
    const userPublicKey = requireStr(b.userPublicKey, "userPublicKey");
    const amountInLamports = requireNum(b.amountInLamports, "amountInLamports");
    const minAmountOutUsdc = requireNum(b.minAmountOutUsdc ?? 0, "minAmountOutUsdc");
    const closeWsolRequested = !!b.closeWsol;

    if (amountInLamports <= 0) throw new Error("amountInLamports must be > 0");
    if (minAmountOutUsdc < 0) throw new Error("minAmountOutUsdc must be >= 0");

    const user = new PublicKey(userPublicKey);
    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);

    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    if (createUsdc) tx.add(createUsdc);

    const built = await buildClmmSwapIxs({ owner:user, amountInLamports:Math.trunc(amountInLamports), minAmountOutUsdc:Math.trunc(minAmountOutUsdc) });
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
    res.json({ ok:true, version:VERSION, builder: built.builder, pool:built.poolId.toBase58(), poolType:built.poolType, usdcAta:built.usdcAta.toBase58(), wsolAta:built.wsolAta.toBase58(), closeWsolRequested, closeWsolApplied, tx:b64 });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message, debug:{ rawBody:req.rawBody||"", jsonError:req.jsonError||null, parsedBody:req.jsonBody||null } });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
