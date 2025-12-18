import express from "express";
import dotenv from "dotenv";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

dotenv.config();

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
    const logs = sim.value.logs?.slice(-80) || [];
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

async function loadRaydiumSdk() {
  const mod = await import("@raydium-io/raydium-sdk");
  // Some builds export everything under default
  const sdk = mod?.default && Object.keys(mod).length <= 2 ? mod.default : (mod.default ?? mod);
  return { mod, sdk };
}

async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const { mod, sdk } = await loadRaydiumSdk();
  const pool = await fetchBestPool();
  const poolId = new PublicKey(pool.id);
  const { usdcAta, wsolAta } = deriveAtas(owner);

  const clmm = sdk?.Clmm;
  const clmmMethods = clmm ? Object.getOwnPropertyNames(clmm).sort() : [];
  const diagBase = {
    poolType: pool?.type,
    poolProgramId: pool?.programId,
    poolId: poolId.toBase58(),
    sdkTopKeys: Object.keys(mod).sort(),
    sdkKeys: Object.keys(sdk || {}).sort(),
    hasClmm: !!clmm,
    clmmMethods,
  };

  if (!clmm) {
    throw new Error("Raydium SDK Clmm not accessible at runtime. diag=" + JSON.stringify(diagBase, null, 2));
  }

  // Try to fetch full poolInfo via multiple calling conventions.
  let poolInfo = null;
  let fetcherTried = null;
  let fetchError = null;

  const fetchers = [
    async () => {
      if (!clmm.fetchMultiplePoolInfos) return;
      fetcherTried = "fetchMultiplePoolInfos(poolIds)";
      const r = await clmm.fetchMultiplePoolInfos({ connection, poolIds: [poolId] });
      poolInfo = r?.[poolId.toBase58()] || r?.poolInfos?.[0] || r?.infos?.[0] || r?.[0] || null;
    },
    async () => {
      if (!clmm.fetchMultiplePoolInfos) return;
      fetcherTried = "fetchMultiplePoolInfos(poolKeys:{id})";
      const r = await clmm.fetchMultiplePoolInfos({ connection, poolKeys: [{ id: poolId }] });
      poolInfo = r?.[poolId.toBase58()] || r?.poolInfos?.[0] || r?.infos?.[0] || r?.[0] || null;
    },
    async () => {
      if (!clmm.fetchPoolInfo) return;
      fetcherTried = "fetchPoolInfo(poolId)";
      const r = await clmm.fetchPoolInfo({ connection, poolId });
      poolInfo = r?.poolInfo || r?.info || r || null;
    },
    async () => {
      if (!clmm.getPoolInfoFromRpc) return;
      fetcherTried = "getPoolInfoFromRpc(poolId)";
      const r = await clmm.getPoolInfoFromRpc({ connection, poolId });
      poolInfo = r?.poolInfo || r?.info || r || null;
    },
  ];

  for (const f of fetchers) {
    try {
      await f();
      if (poolInfo) break;
    } catch (e) {
      fetchError = e?.message || String(e);
      // keep trying others
    }
  }

  // Now attempt swap build.
  let lastErr = null;

  const tryBuild = async (label, fn) => {
    try {
      const r = await fn();
      const ixs = [];
      const inner = r?.innerTransactions || r?.innerTxs || [];
      for (const itx of inner) for (const ix of (itx.instructions || [])) ixs.push(ix);
      if (!ixs.length && Array.isArray(r?.instructions)) ixs.push(...r.instructions);
      if (!ixs.length && Array.isArray(r)) ixs.push(...r);
      if (ixs.length) return ixs;
      throw new Error(label + " returned no instructions");
    } catch (e) {
      lastErr = e;
      return null;
    }
  };

  let ixs = null;

  if (clmm.makeSwapInstructionSimple) {
    ixs = await tryBuild("makeSwapInstructionSimple", async () => clmm.makeSwapInstructionSimple({
      connection,
      poolInfo: poolInfo || { id: poolId },
      ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
      amountIn: BigInt(amountIn),
      minAmountOut: BigInt(minAmountOut),
    }));
  }

  if (!ixs && clmm.makeSwapBaseInInstructions) {
    ixs = await tryBuild("makeSwapBaseInInstructions", async () => clmm.makeSwapBaseInInstructions({
      connection,
      poolInfo: poolInfo || { id: poolId },
      ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
      amountIn: BigInt(amountIn),
      amountOutMin: BigInt(minAmountOut),
    }));
  }

  if (!ixs) {
    const diag = {
      ...diagBase,
      fetcherTried,
      fetchError,
      poolInfoKeys: poolInfo ? Object.keys(poolInfo) : null,
      lastError: lastErr?.message || String(lastErr),
    };
    throw new Error("CLMM swap build failed: " + JSON.stringify(diag, null, 2));
  }

  return { ixs, poolId, usdcAta, wsolAta, diag: { fetcherTried, hasPoolInfo: !!poolInfo } };
}

/* Routes */
app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const bh = await connection.getBlockHeight();
    res.json({ ok: true, rpc: RPC, blockHeight: bh });
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
    res.json({ ok: true, wallet: owner.toBase58(), usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58(), usdcAtaExists: usdcExists, wsolAtaExists: wsolExists });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get("/sdk-shape", async (_req, res) => {
  try {
    rateLimit();
    const { mod, sdk } = await loadRaydiumSdk();
    res.json({
      ok: true,
      topLevelKeys: Object.keys(mod).sort(),
      hasDefault: !!mod.default,
      defaultKeys: mod.default ? Object.keys(mod.default).sort() : null,
      sdkKeys: Object.keys(sdk || {}).sort(),
      hasClmm: !!sdk?.Clmm,
      clmmMethods: sdk?.Clmm ? Object.getOwnPropertyNames(sdk.Clmm).sort() : [],
    });
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

      tx.__pool = built.poolId.toBase58();
      tx.__atas = { usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58() };
      tx.__diag = built.diag;
    } else {
      throw new Error("Unknown mode. Use noop or clmm_swap.");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    await simulateOrThrow(tx);

    res.json({ ok: true, note: m, pool: tx.__pool, atas: tx.__atas, diag: tx.__diag, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API (CLMM auto-ATA diag v2) listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
