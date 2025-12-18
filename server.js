import express from "express";
import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const RAYDIUM_CLMM_PROGRAM_ID  = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/* ---------- Simple rate limit ---------- */
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
    const logs = sim.value.logs?.slice(-40) || [];
    throw new Error("Simulation failed: " + JSON.stringify(sim.value.err) + "\n" + logs.join("\n"));
  }
  return sim.value.logs || [];
}

/* ---------- Raydium API: get best SOL/USDC pool (CLMM) ---------- */
async function fetchBestPool() {
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT.toBase58()}&mint2=${WSOL_MINT.toBase58()}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Raydium API HTTP ${res.status}`);
  const json = await res.json();
  const list =
    json?.data?.data || json?.data?.list || json?.data || json?.result?.data || json?.result || [];
  if (!Array.isArray(list) || !list.length) throw new Error("No pools returned");
  return list[0];
}

/* ---------- ATA derivation + auto-create ---------- */
function deriveAtas(owner) {
  const usdcAta = getAssociatedTokenAddressSync(USDC_MINT, owner, false);
  const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, owner, false);
  return { usdcAta, wsolAta };
}

async function ensureAtaIx(payerOwner, ata, mint) {
  const info = await connection.getAccountInfo(ata);
  if (info) return null; // exists
  // payerOwner signs and pays rent
  return createAssociatedTokenAccountInstruction(
    payerOwner, // payer
    ata,        // ata
    payerOwner, // owner
    mint
  );
}

/* ---------- CLMM swap builder (best-effort via installed raydium-sdk) ---------- */
async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const sdk = await import("@raydium-io/raydium-sdk");
  const pool = await fetchBestPool();

  if (!pool?.type || String(pool.type).toLowerCase() !== "concentrated") {
    throw new Error("Raydium best pool is not CLMM right now.");
  }
  if (pool?.programId && pool.programId !== RAYDIUM_CLMM_PROGRAM_ID.toBase58()) {
    // still allow, but warn in logs
    console.log("Warning: pool programId differs:", pool.programId);
  }

  const poolId = new PublicKey(pool.id);
  const { usdcAta, wsolAta } = deriveAtas(owner);

  // We attempt a few known CLMM builders depending on SDK version.
  const attempts = [];

  if (sdk.Clmm?.makeSwapInstructionSimple) {
    attempts.push(async () => {
      const r = await sdk.Clmm.makeSwapInstructionSimple({
        connection,
        poolInfo: { id: poolId },
        ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
      });
      const ixs = [];
      const inner = r?.innerTransactions || r?.innerTxs || [];
      for (const itx of inner) for (const ix of (itx.instructions || [])) ixs.push(ix);
      if (!ixs.length && Array.isArray(r?.instructions)) ixs.push(...r.instructions);
      return ixs;
    });
  }

  if (sdk.Clmm?.makeSwapBaseInInstructions) {
    attempts.push(async () => {
      const r = await sdk.Clmm.makeSwapBaseInInstructions({
        connection,
        poolInfo: { id: poolId },
        ownerInfo: { wallet: owner, tokenAccountIn: usdcAta, tokenAccountOut: wsolAta },
        amountIn: BigInt(amountIn),
        amountOutMin: BigInt(minAmountOut),
      });
      const inner = r?.innerTransactions || [];
      const ixs = inner.flatMap(t => t.instructions || []);
      if (ixs.length) return ixs;
      if (Array.isArray(r?.instructions)) return r.instructions;
      return [];
    });
  }

  if (sdk.swapInstruction) {
    // generic swapInstruction exists; try a minimal call if supported by this build
    attempts.push(async () => {
      // This is highly version-dependent; may throw. Kept as a fallback.
      const ix = await sdk.swapInstruction({
        poolId,
        owner,
        tokenAccountIn: usdcAta,
        tokenAccountOut: wsolAta,
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
      });
      return ix ? [ix] : [];
    });
  }

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const ixs = await fn();
      if (ixs && ixs.length) return { ixs, poolId, usdcAta, wsolAta };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("CLMM swap build failed: " + (lastErr?.message || String(lastErr)));
}

/* ---------- Routes ---------- */
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
    res.json({
      ok: true,
      wallet: owner.toBase58(),
      usdcMint: USDC_MINT.toBase58(),
      wsolMint: WSOL_MINT.toBase58(),
      usdcAta: usdcAta.toBase58(),
      wsolAta: wsolAta.toBase58(),
      usdcAtaExists: usdcExists,
      wsolAtaExists: wsolExists,
      note: "If an ATA does not exist, /build-tx will include a create-ATA instruction (requires a small SOL rent payment).",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
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

app.get("/raydium-sdk-exports", async (_req, res) => {
  try {
    rateLimit();
    const sdk = await import("@raydium-io/raydium-sdk");
    res.json({ ok: true, exports: Object.keys(sdk).sort() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /build-tx
 * body:
 *  - userPublicKey: string
 *  - mode: "noop" | "clmm_swap"
 *  - amountIn: number (USDC base units; 1 USDC = 1_000_000)
 *  - minAmountOut: number (wSOL base units; 1 SOL = 1_000_000_000)
 */
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
    if (m === "noop") {
      tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    } else if (m === "clmm_swap") {
      const ain = Number(amountIn ?? 0);
      if (!ain || ain <= 0) throw new Error("amountIn must be > 0 (USDC base units)");
      const mout = Number(minAmountOut ?? 0);

      // Ensure ATAs (auto-derive from wallet)
      const { usdcAta, wsolAta } = deriveAtas(user);
      const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
      const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
      if (createUsdc) tx.add(createUsdc);
      if (createWsol) tx.add(createWsol);

      // Build CLMM swap (USDC -> wSOL)
      const built = await buildClmmSwapIxs({ owner: user, amountIn: ain, minAmountOut: mout });
      for (const ix of built.ixs) tx.add(ix);

      tx.__atas = { usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58() };
      tx.__pool = built.poolId.toBase58();
    } else {
      throw new Error("Unknown mode. Use noop or clmm_swap.");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    await simulateOrThrow(tx);

    res.json({
      ok: true,
      note: m,
      pool: tx.__pool,
      atas: tx.__atas,
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      tip: "If you have very low SOL, create-ATA instructions may fail due to rent. You only need a small amount of SOL once.",
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API (CLMM auto-ATA) listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
