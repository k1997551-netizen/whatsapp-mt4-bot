const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const fs = require("fs-extra");
const axios = require("axios");
const SignalParser = require("./signalParser");

const TRUSTED_SENDER = process.env.TRUSTED_SENDER || "";
const TRUSTED_GROUP  = process.env.TRUSTED_GROUP  || "";
const LOT_SIZE       = parseFloat(process.env.LOT_SIZE || "0.01");
const META_TOKEN     = process.env.META_TOKEN || "";
const META_ACCOUNT   = process.env.META_ACCOUNT_ID || "";
const MAX_TRADES     = parseInt(process.env.MAX_TRADES_PER_DAY || "5");

let dailyTrades = 0;
let lastDate = new Date().toDateString();
const parser = new SignalParser();

fs.ensureDirSync("./auth");
fs.ensureDirSync("./logs");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync("./logs/bot.log", line + "\n");
}

function checkReset() {
  const today = new Date().toDateString();
  if (today !== lastDate) { dailyTrades = 0; lastDate = today; log("✅ Reset daily trades"); }
}

async function executeTrade(signal) {
  if (!META_TOKEN || !META_ACCOUNT) {
    log("⚠️ MetaAPI not configured - trade skipped");
    return;
  }
  try {
    const type = signal.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";
    await axios.post(
      `https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${META_ACCOUNT}/trade`,
      { actionType: type, symbol: signal.symbol, volume: LOT_SIZE,
        stopLoss: signal.sl || 0, takeProfit: signal.tp1 || 0 },
      { headers: { "auth-token": META_TOKEN } }
    );
    log(`✅ Trade executed: ${signal.direction} ${signal.symbol} lot:${LOT_SIZE}`);
  } catch (e) {
    log(`❌ Trade error: ${e.message}`);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log("📱 QR Code ready - scan with WhatsApp");
    }
    if (connection === "open") {
      log("🟢 WhatsApp connected! Bot is running...");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        log("🔄 Reconnecting...");
        setTimeout(startBot, 3000);
      } else {
        log("❌ Logged out - delete auth folder and restart");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const from = msg.key.remoteJid || "";
      const text = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text || "";
      if (!text) continue;

      const isTrusted = (TRUSTED_SENDER && from.includes(TRUSTED_SENDER)) ||
                        (TRUSTED_GROUP && from.includes(TRUSTED_GROUP));
      if (!isTrusted) continue;

      log(`📩 Message from ${from}: ${text.substring(0, 60)}`);

      const signal = parser.parse(text);
      if (!signal) { log("ℹ️ Not a signal"); continue; }

      log(`🔍 Signal: ${parser.format(signal)}`);
      console.log("\n" + "─".repeat(40));
      console.log(parser.format(signal));
      console.log("─".repeat(40) + "\n");

      if (signal.action === "OPEN") {
        checkReset();
        if (dailyTrades >= MAX_TRADES) { log("⛔ Daily limit reached"); continue; }
        await executeTrade(signal);
        dailyTrades++;
        log(`📊 Daily trades: ${dailyTrades}/${MAX_TRADES}`);
      } else if (signal.action === "CLOSE") {
        log(`🔴 Close signal for: ${signal.symbol}`);
      }
    }
  });
}

log("🚀 Starting WhatsApp-MT4 Bot...");
startBot();
