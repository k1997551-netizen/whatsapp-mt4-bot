const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino    = require("pino");
const fs      = require("fs-extra");
const axios   = require("axios");
const express = require("express");
const QRCode  = require("qrcode");

const TRUSTED_SENDER = process.env.TRUSTED_SENDER || "";
const LOT_SIZE       = parseFloat(process.env.LOT_SIZE || "0.01");
const META_TOKEN     = process.env.META_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT_ID || "";
const MAX_TRADES     = parseInt(process.env.MAX_TRADES_PER_DAY || "5");
const PORT           = process.env.PORT || 3000;

let currentQR = null;
let isConnected = false;
let dailyTrades = 0;
let lastDate = new Date().toDateString();
let botStatus = "starting";

fs.ensureDirSync("./auth");
const parser = require("./signalParser");
const p = new parser();

// ── Express Server ─────────────────────────
const app = express();

// Keep-alive ping (prevents Railway from sleeping)
setInterval(() => {
  axios.get(`http://localhost:${PORT}/ping`).catch(() => {});
}, 25000);

app.get("/ping", (req, res) => res.send("ok"));

app.get("/", async (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{background:#0d1117;color:#00ff88;font-family:Arial;text-align:center;padding:60px}</style>
      </head><body>
      <h1>✅ البوت متصل بواتساب!</h1>
      <h3>يراقب توصيات بشار المجرفي تلقائياً 🤖</h3>
      <p style="color:#ccc">رقم المراقَب: ${TRUSTED_SENDER}</p>
      </body></html>`);
  }
  if (!currentQR) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="5">
      <style>body{background:#0d1117;color:#fff;font-family:Arial;text-align:center;padding:60px}</style>
      </head><body>
      <h2>⏳ جاري تشغيل البوت...</h2>
      <p>الحالة: ${botStatus}</p>
      <p style="color:#888">تحديث تلقائي كل 5 ثوانٍ</p>
      </body></html>`);
  }
  try {
    const img = await QRCode.toDataURL(currentQR, { width: 350, margin: 2, color: { dark: "#000", light: "#fff" } });
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta http-equiv="refresh" content="25">
      <style>body{background:#0d1117;color:#fff;font-family:Arial;text-align:center;padding:30px}
      img{border:8px solid #00ff88;border-radius:12px}
      h2{color:#00ff88}</style>
      </head><body>
      <h2>📱 امسح الكود بواتساب</h2>
      <img src="${img}"/><br><br>
      <p>واتساب ← ⋮ ← الأجهزة المرتبطة ← ربط جهاز</p>
      <p style="color:#888;font-size:13px">ينتهي الكود بعد 60 ثانية - يتجدد تلقائياً</p>
      </body></html>`);
  } catch(e) {
    return res.send("Error: " + e.message);
  }
});

app.listen(PORT, () => console.log("🌐 Server on port " + PORT));

// ── WhatsApp Bot ───────────────────────────
async function startBot() {
  botStatus = "connecting to WhatsApp...";
  console.log("🚀 Starting bot...");

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      browser: ["WhatsApp-MT4-Bot", "Chrome", "1.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        currentQR = qr;
        botStatus = "QR ready - scan now!";
        console.log("📱 QR Code generated!");
      }
      if (connection === "open") {
        isConnected = true;
        currentQR = null;
        botStatus = "connected";
        console.log("🟢 WhatsApp Connected!");
      }
      if (connection === "close") {
        isConnected = false;
        currentQR = null;
        botStatus = "reconnecting...";
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log("🔄 Reconnecting... code:", code);
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startBot, 5000);
        } else {
          console.log("❌ Logged out");
          fs.removeSync("./auth");
          setTimeout(startBot, 3000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid || "";
        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text || "";
        if (!text || !TRUSTED_SENDER) continue;
        if (!from.includes(TRUSTED_SENDER)) continue;

        console.log("📩 Signal from trusted sender:", text.substring(0, 60));
        const signal = p.parse(text);
        if (!signal || signal.action !== "OPEN") continue;

        const today = new Date().toDateString();
        if (today !== lastDate) { dailyTrades = 0; lastDate = today; }
        if (dailyTrades >= MAX_TRADES) { console.log("⛔ Daily limit"); continue; }

        console.log("🔍 Signal:", p.format(signal));

        if (META_TOKEN && META_ACCOUNT) {
          try {
            await axios.post(
              "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/" + META_ACCOUNT + "/trade",
              { actionType: signal.direction.includes("BUY") ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
                symbol: signal.symbol, volume: LOT_SIZE,
                stopLoss: signal.sl || 0, takeProfit: signal.tp1 || 0 },
              { headers: { "auth-token": META_TOKEN } }
            );
            console.log("✅ Trade executed:", signal.direction, signal.symbol);
          } catch(e) { console.log("❌ Trade error:", e.message); }
        }
        dailyTrades++;
      }
    });

  } catch(e) {
    botStatus = "error - restarting...";
    console.log("❌ Bot error:", e.message);
    setTimeout(startBot, 5000);
  }
}

startBot();
