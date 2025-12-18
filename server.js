import express from "express";
import dotenv from "dotenv";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

dotenv.config();

const VERSION = "1.4.6-fix5";
const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

let bucket = { ts: Date.now(), n: 0 };
function rateLimit() {
  const now = Date.now();
  if (now - bucket.ts > 60_000) bucket = { ts: now, n: 0 };
  if (bucket.n >= 120) throw new Error("rate limit");
  bucket.n++;
}

async function simulateOrThrow(tx) {
  const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
  if (sim.value.err) {
    const logs = sim.value.logs?.slice(-120) || [];
    throw new Error("Simulation failed: " + JSON.stringify(sim.value.err) + "\\n" + logs.join("\\n"));
  }
  return sim.value.logs || [];
}

async function fetchBestPool() {
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

async function loadSdk() {
  const mod = await import("@raydium-io/raydium-sdk");
  const sdk = (mod && mod.Clmm) ? mod : (mod.default ?? mod);
  return { mod, sdk };
}

async function tryFetchPoolInfo(clmm, poolId, poolApiObj) {
  const idStr = poolId.toBase58();
  const attempts = [
    { name: "poolIds:[string]", args: { connection, poolIds: [idStr] } },
    { name: "poolIds:[PublicKey]", args: { connection, poolIds: [poolId] } },
    { name: "poolKeys:[string]", args: { connection, poolKeys: [idStr] } },
    { name: "poolKeys:[PublicKey]", args: { connection, poolKeys: [poolId] } },
    { name: "poolKeys:[{id:string}]", args: { connection, poolKeys: [{ id: idStr }] } },
    { name: "poolKeys:[{id:PublicKey}]", args: { connection, poolKeys: [{ id: poolId }] } },
    { name: "poolKeys:[apiPoolObj]", args: { connection, poolKeys: [poolApiObj] } },
  ];

  const results = [];
  for (const a of attempts) {
    try {
      const res = await clmm.fetchMultiplePoolInfos(a.args);
      const byId = res?.[idStr];
      const first = res?.poolInfos?.[0] || res?.infos?.[0] || res?.[0] || null;
      const poolInfo = byId || first || null;
      results.push({ name: a.name, ok: !!poolInfo, resShape: Object.keys(res || {}), poolInfoKeys: poolInfo ? Object.keys(poolInfo) : null });
      if (poolInfo) return { poolInfo, fetcherTried: a.name, attemptResults: results };
    } catch (e) {
      results.push({ name: a.name, ok: false, error: e?.message || String(e) });
    }
  }
  return { poolInfo: null, fetcherTried: null, attemptResults: results };
}

async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const { mod, sdk } = await loadSdk();
  const pool = await fetchBestPool();
  const poolId = new PublicKey(pool.id);
  const { usdcAta, wsolAta } = deriveAtas(owner);

  const clmm = sdk?.Clmm;
  const clmmMethods = clmm ? Object.getOwnPropertyNames(clmm).sort() : [];
  if (!clmm) throw new Error("Raydium SDK Clmm missing.");

  const fetched = await tryFetchPoolInfo(clmm, poolId, pool);
  const poolInfo = fetched.poolInfo;

  let lastErr = null;
  try {
    const r = await clmm.makeSwapBaseInInstructions({
      connection,
      poolInfo: poolInfo || { id: poolId },
      ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
      amountIn: BigInt(amountIn),
      amountOutMin: BigInt(minAmountOut),
    });
    const inner = r?.innerTransactions || [];
    const ixs = inner.flatMap(t => t.instructions || []);
    const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
    if (!finalIxs.length) throw new Error("swap builder returned no instructions");
    return { ixs: finalIxs, poolId, usdcAta, wsolAta, diag: { version: VERSION, fetcherTried: fetched.fetcherTried, poolInfoKeys: poolInfo ? Object.keys(poolInfo) : null } };
  } catch (e) {
    lastErr = e;
  }

  const diag = {
    version: VERSION,
    poolType: pool?.type,
    poolProgramId: pool?.programId,
    poolId: poolId.toBase58(),
    hasClmm: !!clmm,
    clmmMethods,
    sdkTopKeysCount: Object.keys(mod).length,
    sdkKeysCount: Object.keys(sdk || {}).length,
    fetcherTried: fetched.fetcherTried,
    fetchAttempts: fetched.attemptResults,
    poolInfoKeys: poolInfo ? Object.keys(poolInfo) : null,
    lastError: lastErr?.message || String(lastErr),
  };
  throw new Error("CLMM swap build failed: " + JSON.stringify(diag, null, 2));
}

/* Routes */
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const bh = await connection.getBlockHeight();
    res.json({ ok: true, version: VERSION, rpc: RPC, blockHeight: bh });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/raydium-raw", async (_req, res) => {
  try {
    rateLimit();
    const pool = await fetchBestPool();
    res.json({ ok: true, keys: Object.keys(pool), pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/clmm-methods", async (_req, res) => {
  try {
    rateLimit();
    const { sdk } = await loadSdk();
    res.json({ ok: true, version: VERSION, hasClmm: !!sdk?.Clmm, clmmMethods: sdk?.Clmm ? Object.getOwnPropertyNames(sdk.Clmm).sort() : [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/derive/:wallet", async (req, res) => {
  try {
    rateLimit();
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    const usdcExists = !!(await connection.getAccountInfo(usdcAta));
    const wsolExists = !!(await connection.getAccountInfo(wsolAta));
    res.json({ ok: true, version: VERSION, wallet: owner.toBase58(), usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58(), usdcAtaExists: usdcExists, wsolAtaExists: wsolExists });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/try-fetch", async (_req, res) => {
  try {
    rateLimit();
    const { sdk } = await loadSdk();
    const pool = await fetchBestPool();
    const poolId = new PublicKey(pool.id);
    const fetched = await tryFetchPoolInfo(sdk.Clmm, poolId, pool);
    res.json({ ok: true, version: VERSION, poolId: poolId.toBase58(), fetcherTried: fetched.fetcherTried, attempts: fetched.attemptResults });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/build-tx", async (req, res) => {
  try {
    rateLimit();
    const { userPublicKey, mode, amountIn, minAmountOut } = req.body || {};
    if (!userPublicKey) throw new Error("Missing userPublicKey");
    const user = new PublicKey(userPublicKey);

    const tx = new Transaction();
    tx.feePayer = user;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }));

    const m = mode || "noop";
    if (m === "noop") {
      tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    } else if (m === "clmm_swap") {
      const ain = Number(amountIn ?? 0);
      if (!ain || ain <= 0) throw new Error("amountIn must be > 0 (USDC base units)");
      const mout = Number(minAmountOut ?? 0);

      const { usdcAta, wsolAta } = deriveAtas(user);
      const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
      const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
      if (createUsdc) tx.add(createUsdc);
      if (createWsol) tx.add(createWsol);

      const built = await buildClmmSwapIxs({ owner: user, amountIn: ain, minAmountOut: mout });
      for (const ix of built.ixs) tx.add(ix);

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;

      await simulateOrThrow(tx);

      return res.json({ ok: true, version: VERSION, note: m, pool: built.poolId.toBase58(), atas: { usdcAta: built.usdcAta.toBase58(), wsolAta: built.wsolAta.toBase58() }, diag: built.diag, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
    } else {
      throw new Error("Unknown mode. Use noop or clmm_swap.");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    await simulateOrThrow(tx);
    res.json({ ok: true, version: VERSION, note: m, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API ${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
