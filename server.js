const express = require("express");
const dotenv = require("dotenv");
const {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} = require("@solana/spl-token");

dotenv.config();

const VERSION = "1.5.3-fix11-setup-wrap";
const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

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

async function simulateOrThrow(tx) {
  const sim = await connection.simulateTransaction(tx, {
    replaceRecentBlockhash: true,
    sigVerify: false,
  });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-180);
    throw new Error(
      "Simulation failed: " +
        JSON.stringify(sim.value.err) +
        "\n" +
        logs.join("\n")
    );
  }
  return sim.value.logs || [];
}

async function loadSdk() {
  const mod = await import("@raydium-io/raydium-sdk");
  return mod && mod.Clmm ? mod : mod.default ?? mod;
}

async function fetchBestPool() {
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT.toBase58()}&mint2=${WSOL_MINT.toBase58()}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Raydium API HTTP ${res.status}`);
  const json = await res.json();
  const list =
    json?.data?.data ||
    json?.data?.list ||
    json?.data ||
    json?.result?.data ||
    json?.result ||
    [];
  if (!Array.isArray(list) || !list.length) throw new Error("No pools returned");
  return list[0];
}

function pkFromLayoutField(x) {
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
  if (!sdk.PoolInfoLayout?.decode)
    throw new Error("PoolInfoLayout.decode missing in Raydium SDK");
  const acc = await connection.getAccountInfo(poolId);
  if (!acc?.data) throw new Error("Pool account not found");
  const decoded = sdk.PoolInfoLayout.decode(acc.data);
  const pubkeys = extractPubkeys(decoded);
  return { decoded, decodedKeys: Object.keys(decoded), pubkeys };
}

/**
 * IMPORTANT: Raydium CLMM swap builders often fetch tokenAccountIn/out to read the mint.
 * If your ATAs don't exist yet, the builder can throw "Cannot read properties of undefined (reading 'equals')".
 * Fix11 adds a SETUP tx to create ATAs and wrap SOL to WSOL *first*.
 *
 * Flow:
 * 1) POST /build-setup-tx -> sign/send in Phantom (creates WSOL ATA, USDC ATA, wraps SOL into WSOL ATA)
 * 2) POST /build-swap-tx  -> sign/send in Phantom (swaps WSOL -> USDC on CLMM; closes WSOL ATA to unwrap leftovers optionally)
 */

async function buildClmmSwapIxs({ owner, amountInLamports, minAmountOutUsdc }) {
  const sdk = await loadSdk();
  const apiPool = await fetchBestPool();
  const poolId = new PublicKey(apiPool.id);

  const { decoded } = await decodeClmmPoolState(sdk, poolId);
  const { usdcAta, wsolAta } = deriveAtas(owner);

  // Ensure WSOL ATA exists BEFORE calling this endpoint, or builder may fail
  const wsolInfo = await connection.getAccountInfo(wsolAta);
  if (!wsolInfo) {
    throw new Error(
      "WSOL ATA does not exist yet. Call POST /build-setup-tx first to create ATAs + wrap SOL."
    );
  }

  const poolKeys = { id: poolId, programId: new PublicKey(apiPool.programId) };
  const poolInfo = { ...decoded, id: poolId, programId: poolKeys.programId };

  for (const k of ["ammConfig", "mintA", "mintB", "vaultA", "vaultB", "observationId"]) {
    if (poolInfo[k]) {
      const pk = pkFromLayoutField(poolInfo[k]);
      if (pk) poolInfo[k] = pk;
    }
  }

  if (!sdk.Clmm?.makeSwapBaseInInstructions)
    throw new Error("Clmm.makeSwapBaseInInstructions missing");

  // Swap WSOL -> USDC (base in)
  const r = await sdk.Clmm.makeSwapBaseInInstructions({
    connection,
    poolInfo,
    poolKeys,
    ownerInfo: { wallet: owner, tokenAccountIn: wsolAta, tokenAccountOut: usdcAta },
    amountIn: BigInt(amountInLamports),       // WSOL amount in lamports
    amountOutMin: BigInt(minAmountOutUsdc),   // USDC min out (base units)
  });

  const inner = r?.innerTransactions || [];
  const ixs = inner.flatMap((t) => t.instructions || []);
  const finalIxs = ixs.length ? ixs : Array.isArray(r?.instructions) ? r.instructions : [];
  if (!finalIxs.length) throw new Error("swap builder returned no instructions");

  return { ixs: finalIxs, poolId, poolType: apiPool.type, poolProgramId: apiPool.programId };
}

function addCompute(tx) {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }));
}

async function finalizeTx(tx, feePayer) {
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  await simulateOrThrow(tx);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

// Root + version routes
app.get("/", (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    endpoints: ["/version", "/try-fetch", "/derive/:wallet", "/build-setup-tx", "/build-swap-tx"],
  })
);
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

app.get("/try-fetch", async (_req, res) => {
  try {
    const sdk = await loadSdk();
    const apiPool = await fetchBestPool();
    const poolId = new PublicKey(apiPool.id);
    const decoded = await decodeClmmPoolState(sdk, poolId);
    res.json({
      ok: true,
      version: VERSION,
      poolId: poolId.toBase58(),
      poolType: apiPool.type,
      poolProgramId: apiPool.programId,
      decoded: { decodedKeys: decoded.decodedKeys, pubkeys: decoded.pubkeys },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/derive/:wallet", (req, res) => {
  try {
    const owner = new PublicKey(req.params.wallet);
    const { usdcAta, wsolAta } = deriveAtas(owner);
    res.json({
      ok: true,
      version: VERSION,
      wallet: owner.toBase58(),
      usdcMint: USDC_MINT.toBase58(),
      wsolMint: WSOL_MINT.toBase58(),
      usdcAta: usdcAta.toBase58(),
      wsolAta: wsolAta.toBase58(),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * Setup tx:
 * - creates USDC ATA if missing
 * - creates WSOL ATA if missing
 * - transfers lamports into WSOL ATA (wrap)
 * - sync native
 */
app.post("/build-setup-tx", async (req, res) => {
  try {
    const { userPublicKey, wrapLamports } = req.body || {};
    if (!userPublicKey) throw new Error("Missing userPublicKey");
    const user = new PublicKey(userPublicKey);
    const wrap = Number(wrapLamports ?? 0);
    if (!wrap || wrap <= 0) throw new Error("wrapLamports must be > 0 (lamports to wrap into WSOL)");

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
    if (createUsdc) tx.add(createUsdc);
    if (createWsol) tx.add(createWsol);

    // Transfer lamports into WSOL ATA, then sync native
    tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: wrap }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTx(tx, user);

    res.json({
      ok: true,
      version: VERSION,
      wrapLamports: wrap,
      usdcAta: usdcAta.toBase58(),
      wsolAta: wsolAta.toBase58(),
      tx: b64,
      note: "Sign and send this SETUP tx in Phantom before building the swap tx.",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * Swap tx:
 * - swaps WSOL -> USDC (CLMM)
 * - optionally closes WSOL ATA after swap to unwrap leftovers (recommended when done)
 */
app.post("/build-swap-tx", async (req, res) => {
  try {
    const { userPublicKey, amountInLamports, minAmountOutUsdc, closeWsol } = req.body || {};
    if (!userPublicKey) throw new Error("Missing userPublicKey");
    const user = new PublicKey(userPublicKey);
    const ain = Number(amountInLamports ?? 0);
    if (!ain || ain <= 0) throw new Error("amountInLamports must be > 0 (WSOL lamports)");
    const mout = Number(minAmountOutUsdc ?? 0);
    const doClose = !!closeWsol;

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    if (createUsdc) tx.add(createUsdc);

    const built = await buildClmmSwapIxs({ owner: user, amountInLamports: ain, minAmountOutUsdc: mout });
    for (const ix of built.ixs) tx.add(ix);

    if (doClose) {
      // Close WSOL ATA to unwrap remaining SOL back to wallet
      tx.add(createCloseAccountInstruction(wsolAta, user, user));
    }

    const b64 = await finalizeTx(tx, user);

    res.json({
      ok: true,
      version: VERSION,
      pool: built.poolId.toBase58(),
      poolType: built.poolType,
      usdcAta: usdcAta.toBase58(),
      wsolAta: wsolAta.toBase58(),
      tx: b64,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
