import express from "express";
import dotenv from "dotenv";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Raydium programs (mainnet)
const RAYDIUM_AMM_V4_PROGRAM_ID = "RVKd61ztZW9tJKf8yMWxeHEeFQX2H5zwM1P6m8zXt99";
const RAYDIUM_CLMM_PROGRAM_ID  = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const OPENBOOK_V3_PROGRAM_ID   = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/* ---------- Rate limit ---------- */
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

/* ---------- Minimal config you still must provide ----------
 * We auto-select the AMM v4 pool from Raydium API.
 * You still must provide token accounts used for swap:
 * - userSourceTokenAccount: your USDC ATA
 * - userDestinationTokenAccount: your wSOL ATA
 */
let CONFIG = {
  user: {
    userSourceTokenAccount: "",
    userDestinationTokenAccount: "",
  },
  settings: {
    cuLimit: 1_400_000,
    cuPriceMicroLamports: 80_000,
    requireSimulation: true,
  },
};

/* ---------- Raydium API: fetch list, pick AMM v4 (NOT CLMM) ---------- */
let RAYDIUM_POOL_CACHE = { fetchedAt: 0, pool: null };

async function fetchRaydiumSolUsdcPools() {
  // Request more than 1 and then choose best compatible AMM pool.
  const baseUrl = "https://api-v3.raydium.io/pools/info/mint";
  const url =
    `${baseUrl}?mint1=${USDC_MINT}&mint2=${WSOL_MINT}` +
    // IMPORTANT: CLMM ("Concentrated") is not compatible with Liquidity.makeSwapInstructionSimple
    // We try "standard" first; if API ignores it, we filter client-side.
    `&poolType=standard&poolSortField=default&sortType=desc&pageSize=20&page=1`;

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

  if (!Array.isArray(list) || !list.length) throw new Error("No Raydium SOL/USDC pools returned");
  return list;
}

function isAmmV4Pool(p) {
  // API we saw can return CLMM objects: {type:"Concentrated", programId:"CAMMC..."...}
  // We want standard AMM v4 pools that include OpenBook market account fields.
  if (!p || typeof p !== "object") return false;
  if (p.type && String(p.type).toLowerCase().includes("concentrated")) return false;
  if (p.programId && p.programId === RAYDIUM_CLMM_PROGRAM_ID) return false;

  // Heuristic: must have these OpenBook market fields for AMM v4 swap path.
  const needed = ["id","authority","openOrders","targetOrders","baseVault","quoteVault","marketId","marketBids","marketAsks","marketEventQueue","marketBaseVault","marketQuoteVault","marketAuthority"];
  return needed.every(k => typeof p[k] === "string" && p[k].length > 0);
}

async function getBestAmmV4PoolCached() {
  const now = Date.now();
  if (!RAYDIUM_POOL_CACHE.pool || now - RAYDIUM_POOL_CACHE.fetchedAt > 30 * 60 * 1000) {
    let pools = await fetchRaydiumSolUsdcPools();

    // If API ignored poolType=standard and returned CLMM first, filter.
    const ammPools = pools.filter(isAmmV4Pool);
    if (!ammPools.length) {
      // Try again with poolType=all as fallback and filter again.
      const baseUrl = "https://api-v3.raydium.io/pools/info/mint";
      const url =
        `${baseUrl}?mint1=${USDC_MINT}&mint2=${WSOL_MINT}` +
        `&poolType=all&poolSortField=default&sortType=desc&pageSize=50&page=1`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const json = await res.json();
      const list =
        json?.data?.data || json?.data?.list || json?.data || json?.result?.data || json?.result || [];
      pools = Array.isArray(list) ? list : [];
    }

    const ammPools2 = pools.filter(isAmmV4Pool);
    if (!ammPools2.length) {
      // At this point, we can’t use Liquidity SDK swap; user would need CLMM builder.
      throw new Error("Raydium API returned only CLMM (Concentrated) pools. Need CLMM swap builder to proceed.");
    }

    // "default" sorting from API already ranks; take first compatible AMM pool.
    const pool = ammPools2[0];

    RAYDIUM_POOL_CACHE = { fetchedAt: now, pool };
  }
  return RAYDIUM_POOL_CACHE.pool;
}

/* ---------- Debug endpoints ---------- */
app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const bh = await connection.getBlockHeight();
    res.json({ ok: true, rpc: RPC, blockHeight: bh });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/raydium-raw", async (_req, res) => {
  try {
    rateLimit();
    const pools = await fetchRaydiumSolUsdcPools();
    res.json({ ok: true, count: pools.length, first: pools[0], keys: Object.keys(pools[0] || {}) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/raydium-pool", async (_req, res) => {
  try {
    rateLimit();
    const pool = await getBestAmmV4PoolCached();
    res.json({ ok: true, picked: pool });
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

/* ---------- Raydium AMM v4 swap builder via SDK ---------- */
async function buildRaydiumAmmV4SwapIxs({ owner, amountIn, minAmountOut }) {
  const raydium = await import("@raydium-io/raydium-sdk");
  const { Liquidity } = raydium;

  const p = await getBestAmmV4PoolCached();

  const poolKeys = {
    id: new PublicKey(p.id),
    authority: new PublicKey(p.authority),
    openOrders: new PublicKey(p.openOrders),
    targetOrders: new PublicKey(p.targetOrders),
    baseVault: new PublicKey(p.baseVault),
    quoteVault: new PublicKey(p.quoteVault),

    marketId: new PublicKey(p.marketId),
    marketBids: new PublicKey(p.marketBids),
    marketAsks: new PublicKey(p.marketAsks),
    marketEventQueue: new PublicKey(p.marketEventQueue),
    marketBaseVault: new PublicKey(p.marketBaseVault),
    marketQuoteVault: new PublicKey(p.marketQuoteVault),
    marketAuthority: new PublicKey(p.marketAuthority),

    programId: new PublicKey(RAYDIUM_AMM_V4_PROGRAM_ID),
    marketProgramId: new PublicKey(OPENBOOK_V3_PROGRAM_ID),
  };

  const userKeys = {
    tokenAccountIn: requirePubkey("user.userSourceTokenAccount (USDC ATA)", CONFIG.user.userSourceTokenAccount),
    tokenAccountOut: requirePubkey("user.userDestinationTokenAccount (wSOL ATA)", CONFIG.user.userDestinationTokenAccount),
    owner,
  };

  const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
    connection,
    poolKeys,
    userKeys,
    amountIn: BigInt(amountIn),
    minAmountOut: BigInt(minAmountOut),
    fixedSide: "in",
    makeTxVersion: 0,
  });

  const ixs = [];
  for (const itx of innerTransactions) for (const ix of itx.instructions) ixs.push(ix);
  return ixs;
}

/* ---------- build-tx (swap-only) ----------
 * This zip is focused on fixing pool selection to AMM v4.
 * Once this works, we re-enable the Solend flashloan path on top.
 */
app.post("/build-tx", async (req, res) => {
  try {
    rateLimit();
    const { userPublicKey, mode, amountIn, minAmountOut } = req.body;
    if (!userPublicKey) throw new Error("Missing userPublicKey");
    const user = new PublicKey(userPublicKey);

    const tx = new Transaction();
    tx.feePayer = user;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.settings?.cuLimit ?? 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.settings?.cuPriceMicroLamports ?? 80_000 })
    );

    const m = mode || "noop";
    if (m === "noop") {
      tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    } else if (m === "raydium_swap") {
      const ixs = await buildRaydiumAmmV4SwapIxs({
        owner: user,
        amountIn: Number(amountIn ?? 0),
        minAmountOut: Number(minAmountOut ?? 0),
      });
      for (const ix of ixs) tx.add(ix);
    } else {
      throw new Error("Unknown mode. Use noop or raydium_swap.");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    if (CONFIG.settings?.requireSimulation) await simulateOrThrow(tx);

    res.json({ ok: true, note: m, tx: tx.serialize({ requireAllSignatures: false }).toString("base64") });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Render API listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
  try {
    const p = await getBestAmmV4PoolCached();
    console.log("Picked AMM v4 pool id:", p.id);
  } catch (e) {
    console.log("Pool pick failed:", e.message);
  }
});
