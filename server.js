import express from "express";
import dotenv from "dotenv";
import { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const RAYDIUM_CLMM_PROGRAM_ID  = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

let CONFIG = {
  user: {
    userSourceTokenAccount: "",      // USDC ATA
    userDestinationTokenAccount: "", // wSOL ATA
  },
  settings: {
    cuLimit: 1_600_000,
    cuPriceMicroLamports: 80_000,
    requireSimulation: true,
  }
};

let bucket = { ts: Date.now(), n: 0 };
function rateLimit() {
  const now = Date.now();
  if (now - bucket.ts > 60_000) bucket = { ts: now, n: 0 };
  if (bucket.n >= 120) throw new Error("rate limit");
  bucket.n++;
}
function requirePubkey(label, v) {
  if (!v || typeof v !== "string") throw new Error(`Missing ${label}`);
  return new PublicKey(v);
}
async function simulateOrThrow(tx) {
  const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, sigVerify: false });
  if (sim.value.err) throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));
  return sim.value.logs || [];
}

/* ---------- Raydium API: get best SOL/USDC pool (often CLMM) ---------- */
async function fetchBestPool() {
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT}&mint2=${WSOL_MINT}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Raydium API HTTP ${res.status}`);
  const json = await res.json();
  const list =
    json?.data?.data || json?.data?.list || json?.data || json?.result?.data || json?.result || [];
  if (!Array.isArray(list) || !list.length) throw new Error("No pools returned");
  return list[0];
}

/* ---------- Endpoints ---------- */
app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const bh = await connection.getBlockHeight();
    res.json({ ok: true, rpc: RPC, blockHeight: bh });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/config", (_req, res) => res.json({ ok: true, config: CONFIG }));
app.post("/config", (req, res) => {
  try {
    rateLimit();
    if (!req.body || typeof req.body !== "object") throw new Error("Invalid JSON body");
    CONFIG = req.body;
    res.json({ ok: true });
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

app.get("/raydium-pool", async (_req, res) => {
  try {
    rateLimit();
    const pool = await fetchBestPool();
    res.json({ ok: true, type: pool.type, programId: pool.programId, id: pool.id, tvl: pool.tvl, pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* Debug: show raydium-sdk exports on Render to patch any API mismatch fast */
app.get("/raydium-sdk-exports", async (_req, res) => {
  try {
    rateLimit();
    const sdk = await import("@raydium-io/raydium-sdk");
    res.json({ ok: true, exports: Object.keys(sdk).sort() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- CLMM swap builder (best-effort) ---------- */
async function buildClmmSwapIxs({ owner, amountIn, minAmountOut }) {
  const sdk = await import("@raydium-io/raydium-sdk");
  const pool = await fetchBestPool();

  if (!(pool.type && String(pool.type).toLowerCase().includes("concentrated")) && pool.programId !== RAYDIUM_CLMM_PROGRAM_ID) {
    throw new Error("Picked pool is not CLMM. This backend build expects CLMM for SOL/USDC.");
  }

  const poolId = new PublicKey(pool.id);

  // Common token accounts (user)
  const tokenAccountIn = requirePubkey("user.userSourceTokenAccount (USDC ATA)", CONFIG.user.userSourceTokenAccount);
  const tokenAccountOut = requirePubkey("user.userDestinationTokenAccount (wSOL ATA)", CONFIG.user.userDestinationTokenAccount);

  // CLMM builder APIs differ; try a few known patterns.
  // If it fails, hit /raydium-sdk-exports and paste results.
  const attempts = [];

  // Attempt 1: sdk.Clmm.makeSwapInstructionSimple
  if (sdk.Clmm?.makeSwapInstructionSimple) {
    attempts.push(async () => {
      const r = await sdk.Clmm.makeSwapInstructionSimple({
        connection,
        poolInfo: { id: poolId },
        ownerInfo: { wallet: owner, tokenAccountIn, tokenAccountOut },
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
      });
      const ixs = [];
      const inner = r?.innerTransactions || r?.innerTxs || [];
      for (const itx of inner) for (const ix of itx.instructions || []) ixs.push(ix);
      if (!ixs.length && r?.instructions) ixs.push(...r.instructions);
      return ixs;
    });
  }

  // Attempt 2: sdk.Clmm.makeSwapBaseInInstructions
  if (sdk.Clmm?.makeSwapBaseInInstructions) {
    attempts.push(async () => {
      const r = await sdk.Clmm.makeSwapBaseInInstructions({
        connection,
        poolInfo: { id: poolId },
        ownerInfo: { wallet: owner, tokenAccountIn, tokenAccountOut },
        amountIn: BigInt(amountIn),
        amountOutMin: BigInt(minAmountOut),
      });
      return r?.instructions || r?.innerTransactions?.flatMap(t => t.instructions) || [];
    });
  }

  // Attempt 3: sdk.ClmmInstrument / sdk.ClmmUtils style (very version-dependent)
  if (sdk.ClmmInstrument?.makeSwapInstruction) {
    attempts.push(async () => {
      const r = await sdk.ClmmInstrument.makeSwapInstruction({
        connection,
        poolId,
        owner,
        tokenAccountIn,
        tokenAccountOut,
        amountIn: BigInt(amountIn),
        minAmountOut: BigInt(minAmountOut),
      });
      return r?.instructions || [r];
    });
  }

  if (!attempts.length) {
    throw new Error("Raydium CLMM swap builder not found in installed SDK. Open /raydium-sdk-exports and paste the list here.");
  }

  let lastErr = null;
  for (const fn of attempts) {
    try {
      const ixs = await fn();
      if (ixs && ixs.length) return ixs;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("CLMM swap build failed: " + (lastErr?.message || String(lastErr)));
}

app.post("/build-tx", async (req, res) => {
  try {
    rateLimit();
    const { userPublicKey, mode, amountIn, minAmountOut } = req.body || {};
    if (!userPublicKey) throw new Error("Missing userPublicKey");
    const user = new PublicKey(userPublicKey);

    const tx = new Transaction();
    tx.feePayer = user;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.settings?.cuLimit ?? 1_600_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.settings?.cuPriceMicroLamports ?? 80_000 }),
    );

    const m = mode || "noop";
    if (m === "noop") {
      tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    } else if (m === "clmm_swap") {
      const ixs = await buildClmmSwapIxs({
        owner: user,
        amountIn: Number(amountIn ?? 0),
        minAmountOut: Number(minAmountOut ?? 0),
      });
      for (const ix of ixs) tx.add(ix);
    } else {
      throw new Error("Unknown mode. Use noop or clmm_swap.");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    if (CONFIG.settings?.requireSimulation) await simulateOrThrow(tx);

    res.json({ ok: true, note: m, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API (CLMM swap) listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
  console.log(`Mode: clmm_swap (SOL/USDC)`);
});
