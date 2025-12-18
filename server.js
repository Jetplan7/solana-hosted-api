import express from "express";
import dotenv from "dotenv";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";

dotenv.config();

const VERSION = "1.5.1-fix10";
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

function pkFromLayoutField(x) {
  // BufferLayout often returns Uint8Array(32) or Buffer
  if (!x) return null;
  try {
    if (x instanceof PublicKey) return x;
    if (typeof x === "string") return new PublicKey(x);
    if (x.length === 32) return new PublicKey(x);
  } catch {}
  return null;
}

function extractPubkeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const pk = pkFromLayoutField(v);
    if (pk) out[k] = pk.toBase58();
  }
  return out;
}

async function decodeClmmPoolState(sdk, poolId) {
  if (!sdk.PoolInfoLayout?.decode) throw new Error("PoolInfoLayout.decode missing in Raydium SDK");
  const acc = await connection.getAccountInfo(poolId);
  if (!acc?.data) throw new Error("Pool account not found");
  const decoded = sdk.PoolInfoLayout.decode(acc.data);
  // Try to convert commonly named pubkey fields if present
  const pubkeys = extractPubkeys(decoded);
  return { decodedKeys: Object.keys(decoded), pubkeys };
}

async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const { sdk } = await loadSdk();
  const apiPool = await fetchBestPool();
  const poolId = new PublicKey(apiPool.id);
  const programId = new PublicKey(apiPool.programId);

  // We avoid Clmm.fetchMultiplePoolInfos entirely (it is broken on your environment).
  // Instead decode on-chain pool state and feed it to the swap builder where possible.
  const { decodedKeys, pubkeys } = await decodeClmmPoolState(sdk, poolId);

  const { usdcAta, wsolAta } = deriveAtas(owner);

  // Minimal poolKeys; swap builder may only need id/programId (others inside poolInfo)
  const poolKeys = { id: poolId, programId };

  // Build a "poolInfo" object that includes id + what we can decode
  const acc = await connection.getAccountInfo(poolId);
  const decoded = sdk.PoolInfoLayout.decode(acc.data);
  const poolInfo = { ...decoded, id: poolId, programId };

  // Some decoders leave pubkeys as bytes; ensure at least mintA/mintB/config id if present
  for (const k of ["mintA", "mintB", "mint0", "mint1", "ammConfigId", "configId", "vaultA", "vaultB", "observationId"]) {
    if (poolInfo[k]) {
      const pk = pkFromLayoutField(poolInfo[k]);
      if (pk) poolInfo[k] = pk;
    }
  }

  const clmm = sdk.Clmm;
  if (!clmm?.makeSwapBaseInInstructions) throw new Error("Clmm.makeSwapBaseInInstructions missing");

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
      note: "bypassed fetchMultiplePoolInfos; used PoolInfoLayout.decode",
      decodedKeysCount: decodedKeys.length,
      decodedPubkeys: pubkeys,
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
    const poolId = new PublicKey(apiPool.id);
    const decoded = await decodeClmmPoolState(sdk, poolId);
    res.json({ ok: true, version: VERSION, poolId: poolId.toBase58(), poolType: apiPool.type, poolProgramId: apiPool.programId, decoded });
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
    if ((mode || "") !== "clmm_swap") throw new Error("Only mode=clmm_swap supported in fix10");

    const ain = Number(amountIn ?? 0);
    if (!ain || ain <= 0) throw new Error("amountIn must be > 0 (USDC base units)");
    const mout = Number(minAmountOut ?? 0);

    const tx = new Transaction();
    tx.feePayer = user;
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }));

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

    res.json({ ok: true, version: VERSION, pool: built.poolId.toBase58(), diag: built.diag, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API ${VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
