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

const VERSION = "1.5.4-fix12-debug-echo";
const app = express();

// Capture raw body for debugging
app.use((req, res, next) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    req.rawBody = data;
    next();
  });
});

app.use(express.json({ limit: "2mb", strict: false }));

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

function addCompute(tx) {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_800_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 80_000 }));
}

async function finalizeTx(tx, feePayer) {
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  // We skip simulate here to reduce points of failure during setup debug; you can re-enable later.
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

app.get("/", (_req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    endpoints: ["/version", "/debug/echo", "/derive/:wallet", "/build-setup-tx", "/build-swap-tx"],
  })
);
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

// Debug endpoint: tells us EXACTLY what Render received
app.post("/debug/echo", (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    rawBody: req.rawBody,
    parsedBody: req.body,
    bodyType: typeof req.body,
    hasUserPublicKey: !!(req.body && req.body.userPublicKey),
    hasWrapLamports: req.body && Object.prototype.hasOwnProperty.call(req.body, "wrapLamports"),
  });
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

app.post("/build-setup-tx", async (req, res) => {
  try {
    const body = req.body || {};
    const userPublicKey = body.userPublicKey;
    const wrapLamports = body.wrapLamports;

    if (!userPublicKey) {
      return res.status(400).json({
        ok: false,
        error: "Missing userPublicKey",
        debug: { rawBody: req.rawBody, parsedBody: body, contentType: req.headers["content-type"] },
      });
    }
    const user = new PublicKey(userPublicKey);

    const wrap = Number(wrapLamports);
    if (!Number.isFinite(wrap) || wrap <= 0) {
      return res.status(400).json({
        ok: false,
        error: "wrapLamports must be a positive number (lamports)",
        debug: { wrapLamports, rawBody: req.rawBody, parsedBody: body },
      });
    }

    const tx = new Transaction();
    addCompute(tx);

    const { usdcAta, wsolAta } = deriveAtas(user);
    const createUsdc = await ensureAtaIx(user, usdcAta, USDC_MINT);
    const createWsol = await ensureAtaIx(user, wsolAta, WSOL_MINT);
    if (createUsdc) tx.add(createUsdc);
    if (createWsol) tx.add(createWsol);

    tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: wsolAta, lamports: wrap }));
    tx.add(createSyncNativeInstruction(wsolAta));

    const b64 = await finalizeTx(tx, user);
    res.json({ ok: true, version: VERSION, usdcAta: usdcAta.toBase58(), wsolAta: wsolAta.toBase58(), tx: b64 });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, debug: { rawBody: req.rawBody, parsedBody: req.body } });
  }
});

// Keep swap endpoint placeholder (not needed for this debug step)
app.post("/build-swap-tx", (_req, res) => {
  res.status(501).json({ ok: false, error: "Not implemented in fix12 (debug build). Use fix11 for swap." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
