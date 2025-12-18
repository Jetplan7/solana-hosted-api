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

/**
 * Render Backend — USDC flashloan (Solend) + Raydium-first (SOL/USDC)
 *
 * ✅ Integrates Raydium API auto-pool discovery:
 *    https://api-v3.raydium.io/pools/info/mint?mint1=USDC&mint2=SOL...
 *
 * NOTES:
 * - This backend BUILDS unsigned transactions; wallet signs client-side.
 * - Trust Wallet mobile signs via WalletConnect from your one-page UI.
 * - Solend flashloan helper functions vary by SDK version; if Render logs show a mismatch,
 *   paste the error and we patch the exact call.
 */

const app = express();
app.use(express.json({ limit: "2mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const connection = new Connection(RPC, "confirmed");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/* ---------- Guardrails ---------- */
const LIMITS = {
  MAX_REQ_PER_MIN: 120,
  REQUIRE_SIMULATION: true,
};
let bucket = { ts: Date.now(), n: 0 };
function rateLimit() {
  const now = Date.now();
  if (now - bucket.ts > 60_000) bucket = { ts: now, n: 0 };
  if (bucket.n >= LIMITS.MAX_REQ_PER_MIN) throw new Error("rate limit");
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

/* ---------- Minimal config you still must provide ----------
 * We auto-fill the Raydium pool keys from the Raydium API.
 * You still must provide the user token accounts used for swap:
 * - userSourceTokenAccount: your USDC token account (ATA)
 * - userDestinationTokenAccount: your wSOL token account (ATA)
 */
let CONFIG = {
  user: {
    userSourceTokenAccount: "",
    userDestinationTokenAccount: "",
  },
  settings: {
    cuLimit: 1_400_000,
    cuPriceMicroLamports: 80_000,
  },
};

function requirePubkey(label, v) {
  if (!v || typeof v !== "string") throw new Error(`Missing ${label}`);
  return new PublicKey(v);
}

/* ---------- Raydium API auto-pool discovery ---------- */
let RAYDIUM_POOL_CACHE = {
  fetchedAt: 0,
  pool: null,
};

async function fetchBestRaydiumSolUsdcPool() {
  const baseUrl = "https://api-v3.raydium.io/pools/info/mint";
  const url =
    `${baseUrl}?mint1=${USDC_MINT.toBase58()}` +
    `&mint2=${WSOL_MINT.toBase58()}` +
    `&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1`;

  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`Raydium API failed: HTTP ${res.status}`);
  const json = await res.json();

  const candidates =
    json?.data?.data ||
    json?.data?.list ||
    json?.data ||
    json?.result?.data ||
    json?.result ||
    [];

  const pool = Array.isArray(candidates) ? candidates[0] : null;
  if (!pool) throw new Error("No Raydium SOL/USDC pool found in API response");

  return pool;
}

function normalizePoolToKeys(pool) {
  const get = (...names) => {
    for (const n of names) {
      const v = pool?.[n];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };

  const keys = {
    ammId: get("id", "ammId", "poolId"),
    ammAuthority: get("authority", "ammAuthority"),
    ammOpenOrders: get("openOrders", "ammOpenOrders"),
    ammTargetOrders: get("targetOrders", "ammTargetOrders"),
    poolCoinTokenAccount: get("baseVault", "poolCoinTokenAccount", "coinVault"),
    poolPcTokenAccount: get("quoteVault", "poolPcTokenAccount", "pcVault"),

    serumMarket: get("marketId", "serumMarket", "market"),
    serumBids: get("marketBids", "bids", "serumBids"),
    serumAsks: get("marketAsks", "asks", "serumAsks"),
    serumEventQueue: get("marketEventQueue", "eventQueue", "serumEventQueue"),
    serumBaseVault: get("marketBaseVault", "baseVaultMarket", "serumBaseVault"),
    serumQuoteVault: get("marketQuoteVault", "quoteVaultMarket", "serumQuoteVault"),
    serumVaultSigner: get("marketAuthority", "vaultSigner", "serumVaultSigner"),
  };

  for (const [k, v] of Object.entries(keys)) {
    if (!v) throw new Error(`Raydium pool missing field: ${k}`);
  }
  return keys;
}

async function getRaydiumPoolKeysCached() {
  const now = Date.now();
  if (!RAYDIUM_POOL_CACHE.pool || now - RAYDIUM_POOL_CACHE.fetchedAt > 30 * 60 * 1000) {
    const pool = await fetchBestRaydiumSolUsdcPool();
    const keys = normalizePoolToKeys(pool);
    RAYDIUM_POOL_CACHE = { fetchedAt: now, pool: { raw: pool, keys } };
  }
  return RAYDIUM_POOL_CACHE.pool;
}

/* ---------- Raydium swap builder ---------- */
async function buildRaydiumSwapIxs({ owner, amountIn, minAmountOut }) {
  const raydium = await import("@raydium-io/raydium-sdk");
  const { Liquidity } = raydium;

  const { keys } = await getRaydiumPoolKeysCached();

  const poolKeys = {
    id: new PublicKey(keys.ammId),
    authority: new PublicKey(keys.ammAuthority),
    openOrders: new PublicKey(keys.ammOpenOrders),
    targetOrders: new PublicKey(keys.ammTargetOrders),
    baseVault: new PublicKey(keys.poolCoinTokenAccount),
    quoteVault: new PublicKey(keys.poolPcTokenAccount),

    marketId: new PublicKey(keys.serumMarket),
    marketBids: new PublicKey(keys.serumBids),
    marketAsks: new PublicKey(keys.serumAsks),
    marketEventQueue: new PublicKey(keys.serumEventQueue),
    marketBaseVault: new PublicKey(keys.serumBaseVault),
    marketQuoteVault: new PublicKey(keys.serumQuoteVault),
    marketAuthority: new PublicKey(keys.serumVaultSigner),

    programId: new PublicKey("RVKd61ztZW9tJKf8yMWxeHEeFQX2H5zwM1P6m8zXt99"),
    marketProgramId: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
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

/* ---------- Solend: auto-select best USDC reserve ---------- */
async function autoSelectSolendReserveUSDC() {
  const solend = await import("@solendprotocol/solend-sdk");
  const { SolendMarket } = solend;

  const market = await SolendMarket.initialize(connection, "mainnet");
  await market.loadReserves();

  const usdcReserves = market.reserves
    .map((r) => {
      const mintStr =
        r?.config?.liquidityToken?.mint ||
        r?.config?.liquidityMint ||
        r?.liquidityMint ||
        r?.liquidity?.mint ||
        "";
      let mint = null;
      try { mint = new PublicKey(mintStr); } catch {}
      return { r, mint };
    })
    .filter((x) => x.mint && x.mint.equals(USDC_MINT));

  if (!usdcReserves.length) throw new Error("No USDC reserve found via Solend SDK.");

  const scored = usdcReserves.map(({ r }) => {
    const addrStr = r?.config?.address || r?.address;
    const addr = new PublicKey(addrStr);
    const available = BigInt(r?.stats?.availableLiquidityAmount ?? r?.stats?.availableLiquidity ?? 0);
    const feeBps = Number(r?.config?.fees?.flashLoanFeeBps ?? 0);
    return { r, addr, available, feeBps };
  }).sort((a,b)=>{
    if (a.available !== b.available) return a.available > b.available ? -1 : 1;
    return a.feeBps - b.feeBps;
  });

  return scored[0];
}

/* ---------- Solend flashloan borrow/repay (best-effort) ---------- */
async function buildSolendFlashloanBorrowRepayIxs({ user, amount }) {
  const solend = await import("@solendprotocol/solend-sdk");

  const flashBorrow =
    solend.flashBorrowReserveLiquidityInstruction ||
    solend.flashBorrowReserveLiquidity ||
    solend.flashBorrowReserveLiquidityIx;

  const flashRepay =
    solend.flashRepayReserveLiquidityInstruction ||
    solend.flashRepayReserveLiquidity ||
    solend.flashRepayReserveLiquidityIx;

  if (!flashBorrow || !flashRepay) {
    throw new Error(
      "Solend SDK flashloan helpers not found in this SDK version. " +
      "Open Render logs for the exact missing export and paste it here; I will patch."
    );
  }

  const { r: reserveObj, addr: reserveAddress } = await autoSelectSolendReserveUSDC();

  const lendingMarketStr = reserveObj?.config?.lendingMarket || reserveObj?.lendingMarket;
  const lendingMarket = new PublicKey(lendingMarketStr);

  const liquiditySupplyStr =
    reserveObj?.config?.liquiditySupply ||
    reserveObj?.liquiditySupply ||
    reserveObj?.config?.liquidityToken?.supply ||
    reserveObj?.liquidity?.supply ||
    "";
  const liquiditySupply = new PublicKey(liquiditySupplyStr);

  const feeReceiverStr =
    reserveObj?.config?.feeReceiver ||
    reserveObj?.feeReceiver ||
    reserveObj?.config?.liquidityFeeReceiver ||
    "";
  const feeReceiver = feeReceiverStr ? new PublicKey(feeReceiverStr) : user;

  const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const userUsdcAta = requirePubkey("user.userSourceTokenAccount (USDC ATA)", CONFIG.user.userSourceTokenAccount);

  const borrowIx = flashBorrow(
    amount,
    userUsdcAta,
    liquiditySupply,
    reserveAddress,
    lendingMarket,
    feeReceiver,
    tokenProgramId
  );

  const repayIx = flashRepay(
    amount,
    0,
    userUsdcAta,
    liquiditySupply,
    reserveAddress,
    lendingMarket,
    user,
    tokenProgramId
  );

  return { reserveAddress, borrowIx, repayIx };
}

/* ---------- Routes ---------- */
app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const blockHeight = await connection.getBlockHeight();
    res.json({ ok: true, rpc: RPC, blockHeight });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/config", (_req, res) => {
  res.json({ ok: true, config: CONFIG });
});

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

app.get("/raydium-pool", async (_req, res) => {
  try {
    rateLimit();
    const p = await getRaydiumPoolKeysCached();
    res.json({ ok: true, fetchedAt: RAYDIUM_POOL_CACHE.fetchedAt, keys: p?.keys, raw: p?.raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.settings?.cuPriceMicroLamports ?? 80_000 }),
    );

    const m = mode || "noop";

    if (m === "noop") {
      tx.add(new TransactionInstruction({ programId: new PublicKey("11111111111111111111111111111111"), keys: [], data: Buffer.alloc(0) }));
    } else if (m === "raydium_swap") {
      const ixs = await buildRaydiumSwapIxs({
        owner: user,
        amountIn: Number(amountIn ?? 0),
        minAmountOut: Number(minAmountOut ?? 0),
      });
      for (const ix of ixs) tx.add(ix);
    } else if (m === "flashloan_usdc_raydium_first") {
      const amount = Number(amountIn ?? 0);
      if (!amount || amount <= 0) throw new Error("amountIn must be > 0 (USDC base units)");

      const { reserveAddress, borrowIx, repayIx } = await buildSolendFlashloanBorrowRepayIxs({ user, amount });
      tx.add(borrowIx);

      const swapIxs = await buildRaydiumSwapIxs({
        owner: user,
        amountIn: amount,
        minAmountOut: Number(minAmountOut ?? 0),
      });
      for (const ix of swapIxs) tx.add(ix);

      tx.add(repayIx);
      tx.__reserve = reserveAddress.toBase58();
    } else {
      throw new Error("Unknown mode");
    }

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    if (LIMITS.REQUIRE_SIMULATION) await simulateOrThrow(tx);

    res.json({
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      note: m,
      reserve: tx.__reserve,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/send-signed", async (req, res) => {
  try {
    rateLimit();
    const { signedTxBase64 } = req.body;
    if (!signedTxBase64) throw new Error("Missing signedTxBase64");
    const sig = await connection.sendRawTransaction(Buffer.from(signedTxBase64, "base64"), { skipPreflight: false });
    res.json({ signature: sig });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Render API listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
  try {
    await getRaydiumPoolKeysCached();
    console.log("Raydium pool cache warmed.");
  } catch (e) {
    console.log("Raydium pool cache warm failed:", e.message);
  }
});
