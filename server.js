const express = require("express");
const dotenv = require("dotenv");
dotenv.config();

const VERSION = "1.5.5-fix13-debug-textparser";
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

// Capture body as text for all content-types, then optionally parse JSON ourselves
app.use(express.text({ type: "*/*", limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, version: VERSION, endpoints: ["/version", "/debug/echo"] });
});
app.get("/version", (_req, res) => res.json({ ok: true, version: VERSION }));

app.post("/debug/echo", (req, res) => {
  const rawBody = req.body ?? "";
  const ct = req.headers["content-type"] || "";
  let parsed = null;
  let parseError = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch (e) {
    parseError = String(e && e.message ? e.message : e);
  }
  res.json({
    ok: true,
    version: VERSION,
    contentType: ct,
    rawBody,
    rawBodyLength: typeof rawBody === "string" ? rawBody.length : null,
    parsedBody: parsed,
    parseError,
    headers: req.headers,
  });
});

app.listen(PORT, "0.0.0.0", () => console.log(`API ${VERSION} listening on ${PORT}`));
