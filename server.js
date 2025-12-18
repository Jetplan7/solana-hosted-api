
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

/* ---------- Rate limit ---------- */
let bucket = { ts: Date.now(), n: 0 };
function rateLimit() {
  const now = Date.now();
  if (now - bucket.ts > 60_000) bucket = { ts: now, n: 0 };
  if (bucket.n >= 120) throw new Error("rate limit");
  bucket.n++;
}

/* ---------- Raydium API ---------- */
async function fetchBestRaydiumSolUsdcPool() {
  const url =
    "https://api-v3.raydium.io/pools/info/mint" +
    `?mint1=${USDC_MINT}&mint2=${WSOL_MINT}` +
    "&poolType=all&poolSortField=default&sortType=desc&pageSize=1&page=1";

  const res = await fetch(url);
  if (!res.ok) throw new Error("Raydium API HTTP " + res.status);
  const json = await res.json();

  const list =
    json?.data?.data ||
    json?.data?.list ||
    json?.data ||
    json?.result?.data ||
    json?.result ||
    [];

  if (!Array.isArray(list) || !list.length) {
    throw new Error("No Raydium SOL/USDC pool found");
  }

  return list[0];
}

/* ---------- RAW DEBUG ENDPOINT ---------- */
app.get("/raydium-raw", async (_req, res) => {
  try {
    rateLimit();
    const pool = await fetchBestRaydiumSolUsdcPool();
    res.json({
      ok: true,
      keys: Object.keys(pool),
      pool
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------- TEMP: relaxed pool normalization ---------- */
function normalizePoolToKeys(pool) {
  const get = (...names) => {
    for (const n of names) {
      const v = pool?.[n];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return "";
  };

  return {
    ammId: get("id", "ammId", "poolId", "amm"),
    ammAuthority: get("authority", "ammAuthority", "poolAuthority", "authorityId", "ammAuthorityId"),
    ammOpenOrders: get("openOrders", "ammOpenOrders"),
    ammTargetOrders: get("targetOrders", "ammTargetOrders"),
    poolCoinTokenAccount: get("baseVault", "coinVault"),
    poolPcTokenAccount: get("quoteVault", "pcVault"),

    serumMarket: get("marketId", "market"),
    serumBids: get("marketBids", "bids"),
    serumAsks: get("marketAsks", "asks"),
    serumEventQueue: get("marketEventQueue", "eventQueue"),
    serumBaseVault: get("marketBaseVault"),
    serumQuoteVault: get("marketQuoteVault"),
    serumVaultSigner: get("marketAuthority", "vaultSigner"),
  };
}

app.get("/raydium-pool", async (_req, res) => {
  try {
    rateLimit();
    const pool = await fetchBestRaydiumSolUsdcPool();
    const keys = normalizePoolToKeys(pool);
    res.json({ ok: true, keys, raw: pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/health", async (_req, res) => {
  try {
    const bh = await connection.getBlockHeight();
    res.json({ ok: true, blockHeight: bh });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render API listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
