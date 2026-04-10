
// =============================================
//   البوت الرئيسي - واتساب + MetaAPI + MT4
//   بشار يرسل ← البوت يقرأ ← MetaAPI ينفذ
// =============================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const MetaApi = require('metaapi.cloud-sdk').default;
const express = require('express');
const qrcode  = require('qrcode');
const fs      = require('fs');
const path    = require('path');
const SignalParser = require('./signalParser');

// ── متغيرات البيئة ───────────────────────────
const TRUSTED_SENDER    = process.env.TRUSTED_SENDER    || '';
const LOT_SIZE          = parseFloat(process.env.LOT_SIZE || '0.01');
const MAX_TRADES_PER_DAY= parseInt(process.env.MAX_TRADES_PER_DAY || '10');
const META_TOKEN        = process.env.META_TOKEN        || '';
const META_ACCOUNT_ID   = process.env.META_ACCOUNT_ID   || '';
const PORT              = process.env.PORT              || 3000;

// ── مرتبطات ──────────────────────────────────
const parser     = new SignalParser();
let   currentQR  = null;
let   dailyTrades= 0;
let   lastDate   = new Date().toDateString();
let   metaAccount= null;

// ── تسجيل ────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// ── تصفير الصفقات اليومية ────────────────────
function checkReset() {
  const today = new Date().toDateString();
  if (today !== lastDate) { dailyTrades = 0; lastDate = today; }
}

// ── الاتصال بـ MetaAPI ────────────────────────
async function connectMetaAPI() {
  if (!META_TOKEN || !META_ACCOUNT_ID) {
    log('⚠️ META_TOKEN أو META_ACCOUNT_ID غير موجود - لن يتم تنفيذ الصفقات');
    return null;
  }
  try {
    const api     = new MetaApi(META_TOKEN);
    const account = await api.metatraderAccountApi.getAccount(META_ACCOUNT_ID);

    if (!['DEPLOYING','DEPLOYED'].includes(account.state)) {
      log('🔄 جاري نشر الحساب...');
      await account.deploy();
    }
    log('⏳ انتظار اتصال MT4...');
    await account.waitConnected();

    const connection = account.getRPCConnection();
    await connection.connect();
    await connection.waitSynchronized();

    log('✅ MetaAPI متصل بـ MT4!');
    return connection;
  } catch (err) {
    log('❌ خطأ MetaAPI: ' + err.message);
    return null;
  }
}

// ── تنفيذ الصفقة ──────────────────────────────
async function executeTrade(signal) {
  if (!metaAccount) {
    log('⚠️ MetaAPI غير متصل - تخطي الصفقة');
    return false;
  }
  try {
    const type = signal.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const tradeOptions = {
      actionType: type,
      symbol:     signal.symbol,
      volume:     LOT_SIZE,
    };
    if (signal.sl)  tradeOptions.stopLoss   = signal.sl;
    if (signal.tp1) tradeOptions.takeProfit = signal.tp1;

    log(`📤 إرسال أمر: ${signal.symbol} ${signal.direction} @ LOT=${LOT_SIZE}`);
    const result = await metaAccount.createMarketBuyOrder
      ? await metaAccount.createMarketBuyOrder(signal.symbol, LOT_SIZE, signal.sl, signal.tp1)
      : await metaAccount.trade(tradeOptions);

    log(`✅ صفقة منفذة: ${JSON.stringify(result)}`);
    return true;
  } catch (err) {
    log('❌ خطأ في تنفيذ الصفقة: ' + err.message);
    return false;
  }
}

// ── تنفيذ الصفقة عبر REST مباشر ──────────────
async function executeTradeREST(signal) {
  if (!META_TOKEN || !META_ACCOUNT_ID) return false;
  try {
    const https  = require('https');
    const type   = signal.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const body   = JSON.stringify({
      actionType: type,
      symbol:     signal.symbol,
      volume:     LOT_SIZE,
      stopLoss:   signal.sl   || undefined,
      takeProfit: signal.tp1  || undefined,
    });

    return new Promise((resolve) => {
      const options = {
        hostname: 'mt-client-api-v1.new-york.agiliumtrade.ai',
        path:     `/users/current/accounts/${META_ACCOUNT_ID}/trade`,
        method:   'POST',
        headers:  {
          'Content-Type':  'application/json',
          'auth-token':    META_TOKEN,
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          log(`✅ REST صفقة: ${res.statusCode} - ${data.substring(0,100)}`);
          resolve(res.statusCode < 300);
        });
      });
      req.on('error', (e) => { log('❌ REST خطأ: ' + e.message); resolve(false); });
      req.write(body);
      req.end();
    });
  } catch (err) {
    log('❌ executeTradeREST: ' + err.message);
    return false;
  }
}

// ── Express للـ QR ────────────────────────────
const app = express();
app.get('/', async (req, res) => {
  if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    res.send(`<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><title>WhatsApp QR</title>
<meta http-equiv="refresh" content="15">
<style>body{font-family:Arial;text-align:center;padding:30px;background:#f0f2f5}
h2{color:#128c7e}img{border:3px solid #128c7e;border-radius:12px;padding:10px;background:#fff}</style>
</head><body>
<h2>🤖 امسح كود QR بواتساب</h2>
<p>واتساب ← ⋮ ← الأجهزة المرتبطة ← ربط جهاز</p>
<img src="${img}" width="260"/><br>
<small>تحديث تلقائي كل 15 ثانية</small>
</body></html>`);
  } else {
    res.send(`<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"><title>Bot Status</title>
<meta http-equiv="refresh" content="10">
<style>body{font-family:Arial;text-align:center;padding:40px;background:#f0f2f5}
.ok{color:#128c7e;font-size:48px}.info{color:#555;margin-top:20px}</style>
</head><body>
<div class="ok">✅</div>
<h2>البوت متصل ويعمل</h2>
<div class="info">
  <p>📱 واتساب: متصل</p>
  <p>📊 MetaAPI: ${META_TOKEN ? 'مفعّل' : 'غير مفعّل'}</p>
  <p>🎯 المرسل الموثوق: ${TRUSTED_SENDER || 'الكل'}</p>
  <p>💼 حجم اللوت: ${LOT_SIZE}</p>
</div>
</body></html>`);
  }
});
app.listen(PORT, () => log(`🌐 Server on port ${PORT}`));

// ── واتساب ────────────────────────────────────
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth:           state,
    printQRInTerminal: true,
    browser:        ['WhatsApp MT4 Bot', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      log('📱 QR جاهز - افتح: ' + (process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`));
    }
    if (connection === 'open') {
      currentQR = null;
      log('✅ واتساب متصل!');
      // اتصل بـ MetaAPI بعد اتصال واتساب
      if (!metaAccount) {
        metaAccount = await connectMetaAPI();
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : null;
      if (code !== DisconnectReason.loggedOut) {
        log('🔄 إعادة الاتصال...');
        setTimeout(startWhatsApp, 5000);
      } else {
        log('🚪 تم تسجيل الخروج - امسح QR مرة أخرى');
        setTimeout(startWhatsApp, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || '';
        if (!body.trim()) continue;

        // فحص المرسل
        const sender = msg.key.participant || msg.key.remoteJid || '';
        const senderNumber = sender.replace(/[^0-9]/g, '');

        // إذا في TRUSTED_SENDER افحصه
        if (TRUSTED_SENDER) {
          const trustedNum = TRUSTED_SENDER.replace(/[^0-9]/g, '');
          if (!senderNumber.includes(trustedNum) && !trustedNum.includes(senderNumber)) {
            continue; // تجاهل
          }
        }

        log(`📩 رسالة من ${senderNumber}: ${body.substring(0, 100)}`);

        const signal = parser.parse(body);
        if (!signal) {
          log('ℹ️ ليست توصية - تم تجاهلها');
          continue;
        }

        log(`🔍 توصية: ${JSON.stringify(signal)}`);
        console.log('\n' + '─'.repeat(50));
        console.log(parser.format(signal));
        console.log('─'.repeat(50) + '\n');

        checkReset();
        if (signal.action === 'OPEN') {
          if (dailyTrades >= MAX_TRADES_PER_DAY) {
            log(`⛔ الحد اليومي (${MAX_TRADES_PER_DAY}) - تم التخطي`);
            continue;
          }
          const ok = await executeTradeREST(signal);
          if (ok) {
            dailyTrades++;
            log(`📊 صفقات اليوم: ${dailyTrades}/${MAX_TRADES_PER_DAY}`);
          }
        } else if (signal.action === 'CLOSE') {
          log(`🔴 أمر إغلاق ${signal.symbol}`);
        }

      } catch (err) {
        log('❌ خطأ: ' + err.message);
      }
    }
  });
}

// ── بدء التشغيل ───────────────────────────────
log('🚀 بدء تشغيل البوت...');
startWhatsApp().catch(err => {
  log('❌ خطأ فادح: ' + err.message);
  process.exit(1);
});
