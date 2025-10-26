import "dotenv/config";
import express from "express";

const app = express();
app.disable("x-powered-by");
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
});
