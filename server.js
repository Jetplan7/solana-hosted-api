import express from "express";
import dotenv from "dotenv";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

dotenv.config();

const VERSION = "1.4.9-fix8";
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

function findJsonInfo2PoolKeys(sdk) {
  return sdk.jsonInfo2PoolKeys || sdk.PoolUtils?.jsonInfo2PoolKeys || null;
}

function normalizeMint(x) {
  return x?.address || x?.mint || x || null;
}
function buildJsonInfoVariants(apiPool) {
  const mintA = normalizeMint(apiPool?.mintA);
  const mintB = normalizeMint(apiPool?.mintB);
  const programId = apiPool?.programId || apiPool?.poolProgramId || apiPool?.ammProgramId;
  const configId = apiPool?.config?.id || apiPool?.ammConfigId || apiPool?.ammConfig || apiPool?.configId;

  // Key idea: DO NOT pass `type` at all (some SDK builds treat certain fields positionally and try to PublicKey() it).
  const clmmOnly = {
    id: apiPool.id,
    programId,
    mintA,
    mintB,
    ammConfigId: configId,
    config: configId ? { id: configId } : undefined,
  };

  const clmmOnly2 = {
    id: apiPool.id,
    programId,
    mintA: { address: mintA },
    mintB: { address: mintB },
    config: configId ? { id: configId } : undefined,
  };

  return [
    { name: "full_apiPool_strippedType", jsonInfo: (() => { const { type, pooltype, ...rest } = apiPool; return rest; })() },
    { name: "clmmOnly_strings", jsonInfo: clmmOnly },
    { name: "clmmOnly_nestedMint", jsonInfo: clmmOnly2 },
  ];
}

async function jsonInfoToPoolKeys(sdk, apiPool) {
  const fn = findJsonInfo2PoolKeys(sdk);
  if (!fn) throw new Error("jsonInfo2PoolKeys not found in Raydium SDK exports.");

  const variants = buildJsonInfoVariants(apiPool);
  const attempts = [];

  for (const v of variants) {
    try {
      const poolKeys = fn(v.jsonInfo);
      attempts.push({ name: v.name, ok: true, poolKeysKeys: Object.keys(poolKeys || {}) });
      return { poolKeys, used: v.name, attempts };
    } catch (e) {
      attempts.push({ name: v.name, ok: false, error: e?.message || String(e) });
    }
  }

  throw new Error("jsonInfo2PoolKeys failed for all variants: " + JSON.stringify(attempts, null, 2));
}

async function fetchClmmPoolInfo(clmm, sdk, apiPool) {
  const poolId = new PublicKey(apiPool.id);
  const { poolKeys, used, attempts } = await jsonInfoToPoolKeys(sdk, apiPool);

  const res = await clmm.fetchMultiplePoolInfos({ connection, poolKeys: [poolKeys] });
  const byId = res?.[poolId.toBase58()];
  const first = res?.poolInfos?.[0] || res?.infos?.[0] || res?.[0] || null;
  const poolInfo = byId || first || null;
  if (!poolInfo) throw new Error("fetchMultiplePoolInfos returned no poolInfo. resKeys=" + JSON.stringify(Object.keys(res || {})));
  return { poolId, poolKeys, poolInfo, poolKeysVariant: used, poolKeysAttempts: attempts };
}

async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const { mod, sdk } = await loadSdk();
  const apiPool = await fetchBestPool();

  const clmm = sdk?.Clmm;
  if (!clmm) throw new Error("Raydium SDK Clmm missing.");
  const { poolId, poolKeys, poolInfo, poolKeysVariant, poolKeysAttempts } = await fetchClmmPoolInfo(clmm, sdk, apiPool);

  const { usdcAta, wsolAta } = deriveAtas(owner);

  const r = await clmm.makeSwapBaseInInstructions({
    connection,
    poolInfo,
    poolKeys,
    ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
    amountIn: BigInt(amountIn),
    amountOutMin: BigInt(minAmountOut),
  });

  const inner = r?.innerTransactions || [];
  const ixs = inner.flatMap(t => t.instructions || []);
  const finalIxs = ixs.length ? ixs : (Array.isArray(r?.instructions) ? r.instructions : []);
  if (!finalIxs.length) throw new Error("swap builder returned no instructions");

  return {
    ixs: finalIxs,
    poolId,
    diag: {
      version: VERSION,
      poolType: apiPool?.type,
      poolProgramId: apiPool?.programId,
      poolKeysVariant,
      poolKeysAttempts,
      poolInfoKeys: Object.keys(poolInfo || {}),
      poolKeysKeys: Object.keys(poolKeys || {}),
      sdkKeysCount: Object.keys(sdk || {}).length,
      sdkTopKeysCount: Object.keys(mod || {}).length,
    },
  };
}

/* Routes */
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

app.get("/try-fetch", async (_req, res) => {
  try {
    rateLimit();
    const { sdk } = await loadSdk();
    const apiPool = await fetchBestPool();
    const clmm = sdk.Clmm;

    const out = { ok: true, version: VERSION, poolId: apiPool.id, poolType: apiPool.type, poolProgramId: apiPool.programId };
    out.hasJsonInfo2PoolKeys = !!findJsonInfo2PoolKeys(sdk);

    try {
      const { poolKeys, used, attempts } = await jsonInfoToPoolKeys(sdk, apiPool);
      out.poolKeysVariant = used;
      out.poolKeysAttempts = attempts;
      out.poolKeysKeys = Object.keys(poolKeys || {});

      const r = await clmm.fetchMultiplePoolInfos({ connection, poolKeys: [poolKeys] });
      out.fetchOk = true;
      out.resKeys = Object.keys(r || {});
      out.byId = !!r?.[apiPool.id];
    } catch (e) {
      out.fetchOk = false;
      out.fetchError = e?.message || String(e);
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/derive/:wallet", async (req, res) => {
  try {
    rateLimit();
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({ ok: true, version: VERSION, wallet: owner.toBase58(), usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58() });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
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
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }),
    );

    const m = mode || "noop";
    if (m === "clmm_swap") {
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

      return res.json({
        ok: true,
        version: VERSION,
        note: m,
        pool: built.poolId.toBase58(),
        diag: built.diag,
        tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      });
    }

    tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    await simulateOrThrow(tx);
    res.json({ ok: true, version: VERSION, note: "noop", tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API ${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
