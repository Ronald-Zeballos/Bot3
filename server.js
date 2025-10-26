// server.js
import "dotenv/config";
import express from "express";

const app = express();
app.disable("x-powered-by");

// --- util pequeño para ver rutas registradas ---
function listRoutes(app) {
  const out = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods)
        .filter(Boolean)
        .map((x) => x.toUpperCase())
        .join(",");
      out.push(`${methods} ${m.route.path}`);
    }
  });
  return out.sort();
}

// Health
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Necesario para leer JSON en POST del webhook
app.use(express.json());

// === VERIFICACIÓN DE META (GET) ===
app.get("/wa/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    // responde el challenge tal cual
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
});

// === RECEPCIÓN DE EVENTOS (POST) ===
app.post("/wa/webhook", (req, res) => {
  // Opcional: logear si quieres
  // console.log("WA EVENT:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// Debug: ver rutas disponibles en runtime
app.get("/__routes", (req, res) => {
  res.json({ routes: listRoutes(app) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en :${PORT}`);
});
