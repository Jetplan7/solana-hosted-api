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
app.use(express.json({ limit: "1mb" }));

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// NOTE: Railway provides PORT; we must listen on 0.0.0.0
const connection = new Connection(RPC, "confirmed");

/* ---------- basic guardrails ---------- */
const LIMITS = { MAX_REQ_PER_MIN: 120 };
let bucket = { ts: Date.now(), n: 0 };
function rateLimit() {
  const now = Date.now();
  if (now - bucket.ts > 60_000) bucket = { ts: now, n: 0 };
  if (bucket.n >= LIMITS.MAX_REQ_PER_MIN) throw new Error("rate limit");
  bucket.n++;
}

/* ---------- routes ---------- */
app.get("/health", async (_req, res) => {
  try {
    rateLimit();
    const blockHeight = await connection.getBlockHeight();
    res.json({ ok: true, rpc: RPC, blockHeight });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * build-tx:
 * Returns an UNSIGNED base64 transaction for the client wallet to sign.
 * Replace the "no-op" instruction with your real Solend/Raydium/Orca builders.
 */
app.post("/build-tx", async (req, res) => {
  try {
    rateLimit();
    const { userPublicKey, amount } = req.body;
    if (!userPublicKey) throw new Error("Missing userPublicKey");

    const user = new PublicKey(userPublicKey);

    const tx = new Transaction();
    tx.feePayer = user;

    // conservative priority fee defaults (tune later)
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 })
    );

    // SAFE no-op instruction for connectivity verification
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey("11111111111111111111111111111111"),
        keys: [],
        data: Buffer.alloc(0),
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;

    res.json({
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      note: "Server currently returns a safe no-op tx. Replace with real instruction builders server-side.",
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * send-signed:
 * Broadcasts a SIGNED base64 transaction.
 */
app.post("/send-signed", async (req, res) => {
  try {
    rateLimit();
    const { signedTxBase64 } = req.body;
    if (!signedTxBase64) throw new Error("Missing signedTxBase64");

    const sig = await connection.sendRawTransaction(
      Buffer.from(signedTxBase64, "base64"),
      { skipPreflight: false }
    );

    res.json({ signature: sig });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API listening on 0.0.0.0:${PORT}`);
  console.log(`RPC: ${RPC}`);
});
