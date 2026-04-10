const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino   = require("pino");
const fs     = require("fs-extra");
const axios  = require("axios");
const express = require("express");
const QRCode  = require("qrcode");
const SignalParser = require("./signalParser");

// ── إعدادات ──────────────────────────────────
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
const parser = new SignalParser();

fs.ensureDirSync("./auth");
fs.ensureDirSync("./logs");

// ── سيرفر ويب لعرض QR ────────────────────────
const app = express();

app.get("/", async (req, res) => {
  if (isConnected) {
    return res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:50px;background:#1a1a2e;color:#00ff88">
        <h1>✅ واتساب متصل!</h1>
        <h2>البوت يعمل بشكل طبيعي</h2>
        <p style="color:#ccc">يراقب توصيات بشار المجرفي تلقائياً</p>
      </body></html>
    `);
  }
  if (!currentQR) {
    return res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:50px;background:#1a1a2e;color:#fff">
        <h2>⏳ في انتظار QR Code...</h2>
        <p>أعد تحديث الصفحة بعد 10 ثوانٍ</p>
        <script>setTimeout(()=>location.reload(), 5000)</script>
      </body></html>
    `);
  }
  try {
    const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
    res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:30px;background:#1a1a2e;color:#fff">
        <h2 style="color:#00ff88">📱 امسح الكود بواتساب</h2>
        <img src="${qrImage}" style="border:10px solid white;border-radius:10px"/>
        <p>واتساب ← ⋮ ← الأجهزة المرتبطة ← ربط جهاز</p>
        <p style="color:#888;font-size:12px">الصفحة تتجدد تلقائياً</p>
        <script>setTimeout(()=>location.reload(), 20000)</script>
      </body></html>
    `);
  } catch(e) {
    res.send("Error generating QR: " + e.message);
  }
});

app.listen(PORT, () => console.log(`🌐 QR Server: http://localhost:${PORT}`));

// ── دوال مساعدة ──────────────────────────────
function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg;
  console.log(line);
  fs.appendFileSync("./logs/bot.log", line + "\n");
}

function checkReset() {
  const today = new Date().toDateString();
  if (today !== lastDate) { dailyTrades = 0; lastDate = today; }
}

async function executeTrade(signal) {
  if (!META_TOKEN || !META_ACCOUNT) {
    log("⚠️ MetaAPI غير مضبوط - الصفقة محفوظة في السجل فقط");
    return;
  }
  try {
    const type = signal.direction.includes("BUY") ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
    await axios.post(
      "https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/" + META_ACCOUNT + "/trade",
      { actionType: type, symbol: signal.symbol, volume: LOT_SIZE,
        stopLoss: signal.sl || 0, takeProfit: signal.tp1 || 0 },
      { headers: { "auth-token": META_TOKEN } }
    );
    log("✅ صفقة: " + signal.direction + " " + signal.symbol + " lot:" + LOT_SIZE);
  } catch(e) {
    log("❌ خطأ في الصفقة: " + e.message);
  }
}

// ── تشغيل البوت ──────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      log("📱 QR Code جاهز! افتح: http://localhost:" + PORT);
      console.log("\n🔗 افتح هذا الرابط لمسح QR Code:\n");
    }
    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      log("🟢 واتساب متصل! البوت يعمل الآن");
    }
    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        log("🔄 إعادة الاتصال...");
        setTimeout(startBot, 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid || "";
      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text || "";
      if (!text || !TRUSTED_SENDER) continue;
      if (!from.includes(TRUSTED_SENDER)) continue;

      log("📩 رسالة: " + text.substring(0, 60));
      const signal = parser.parse(text);
      if (!signal) { log("ℹ️ رسالة عادية"); continue; }

      log("🔍 توصية: " + parser.format(signal));
      if (signal.action === "OPEN") {
        checkReset();
        if (dailyTrades >= MAX_TRADES) { log("⛔ تجاوزت الحد اليومي"); continue; }
        await executeTrade(signal);
        dailyTrades++;
      }
    }
  });
}

log("🚀 تشغيل البوت...");
startBot();
