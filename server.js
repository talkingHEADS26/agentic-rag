// server.js
// Haupt-Server: WebSocket (Widget) + HTTP Webhook (WhatsApp)

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { handleMessage } from "./agentHandler.js";
import { ingestText, getChunkStats, deleteAllChunks } from "./ingestKnowledge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// CORS für das Widget
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.WIDGET_ORIGIN || "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ════════════════════════════════════════════════════════
// ADMIN — Basic Auth + Upload Interface
// ════════════════════════════════════════════════════════

function adminAuth(req, res, next) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Basic ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const [, password] = decoded.split(":");
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }
  next();
}

// Chat Widget — Config aus .env injizieren
const WIDGET_CONFIG = JSON.stringify({
  companyName:  process.env.COMPANY_NAME  || "Assistent",
  agentName:    process.env.AGENT_NAME    || "KI-Assistent",
  primaryColor: process.env.WIDGET_PRIMARY_COLOR || "#0E51A0",
  accentColor:  process.env.WIDGET_ACCENT_COLOR  || "#EA9413",
  welcomeMsg:   process.env.WIDGET_WELCOME_MSG   || null,
});

app.get("/", (req, res) => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
  const injected = html.replace(
    "/* __ENV_CONFIG__ */",
    `window.TH_ENV_CONFIG = ${WIDGET_CONFIG};`
  );
  res.setHeader("Content-Type", "text/html");
  res.send(injected);
});

// Upload-Interface HTML
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "upload.html"));
});

// Statistik: wie viele Chunks je Quelle
app.get("/admin/stats", adminAuth, async (req, res) => {
  try {
    const stats = await getChunkStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Gesamte Wissensbasis löschen
app.delete("/admin/chunks", adminAuth, async (req, res) => {
  try {
    await deleteAllChunks();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Dokument hochladen und ingestieren
app.post("/admin/ingest", adminAuth, async (req, res) => {
  try {
    const { content, filename, category } = req.body;
    if (!content || !filename) {
      return res.status(400).json({ ok: false, error: "content und filename erforderlich" });
    }
    const result = await ingestText({ content, filename, category: category || "general" });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════
// WHATSAPP CHANNEL
// ════════════════════════════════════════════════════════

// Webhook Verification (Meta erfordert das beim Setup)
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WhatsApp] Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Eingehende WhatsApp-Nachrichten
app.post("/webhook/whatsapp", async (req, res) => {
  // Meta erwartet sofort 200, sonst Retry
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Nur echte Nachrichten verarbeiten, keine Status-Updates
    if (!value?.messages) return;

    const message = value.messages[0];
    if (message.type !== "text") {
      // Andere Typen (Bild, Voice) optional später
      return;
    }

    const from = message.from; // Telefonnummer = Session ID
    const text = message.text.body;

    console.log(`[WhatsApp] From: ${from} | Message: ${text}`);

    const reply = await handleMessage({
      sessionId: `wa_${from}`,
      message: text,
      channel: "whatsapp",
    });

    await sendWhatsAppMessage(from, reply);
  } catch (err) {
    console.error("[WhatsApp] Error:", err);
  }
});

async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

// ════════════════════════════════════════════════════════
// WIDGET CHANNEL (WebSocket mit Streaming-Support)
// ════════════════════════════════════════════════════════

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/chat" });

wss.on("connection", (ws, req) => {
  // Session-ID aus URL-Param oder UUID generieren
  const url = new URL(req.url, `http://localhost`);
  const sessionId = url.searchParams.get("session") || crypto.randomUUID();

  console.log(`[Widget] New connection: ${sessionId}`);

  ws.send(JSON.stringify({ type: "connected", sessionId }));

  ws.on("message", async (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    const { message } = parsed;
    if (!message?.trim()) return;

    // Typing-Indikator senden
    ws.send(JSON.stringify({ type: "typing", status: true }));

    try {
      const reply = await handleMessage({
        sessionId: `widget_${sessionId}`,
        message,
        channel: "widget",
      });

      ws.send(JSON.stringify({ type: "typing", status: false }));
      ws.send(JSON.stringify({ type: "message", content: reply }));
    } catch (err) {
      console.error("[Widget] Handler error:", err);
      ws.send(JSON.stringify({ type: "typing", status: false }));
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Ein Fehler ist aufgetreten. Bitte versuche es erneut.",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log(`[Widget] Disconnected: ${sessionId}`);
  });
});

// ════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/chat`);
  console.log(`   WhatsApp Webhook: http://localhost:${PORT}/webhook/whatsapp`);
});
