
// =============================================
//   البوت الرئيسي - واتساب + MetaAPI + MT4
//   بشار يرسل ← البوت يقرأ ← MetaAPI ينفذ
// =============================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }       = require('@hapi/boom');
const MetaApi        = require('metaapi.cloud-sdk').default;
const express        = require('express');
const qrcode         = require('qrcode');
const SignalParser   = require('./signalParser');

// ── متغيرات البيئة ──
const TRUSTED_SENDER     = (process.env.TRUSTED_SENDER || '').replace(/[^0-9]/g, '');
const LOT_SIZE           = parseFloat(process.env.LOT_SIZE || '0.01');
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '10');
const META_TOKEN         = process.env.META_TOKEN  || '';
const META_ACCOUNT_ID    = process.env.META_ACCOUNT_ID || '';
const PORT               = process.env.PORT || 3000;

const parser      = new SignalParser();
let   currentQR   = null;
let   dailyTrades = 0;
let   lastDate    = new Date().toDateString();
let   metaConn    = null;   // MetaAPI RPC connection

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function checkReset() {
  const today = new Date().toDateString();
  if (today !== lastDate) { dailyTrades = 0; lastDate = today; log('🔄 تصفير عداد الصفقات اليومية'); }
}

// ════════════════════════════════════════════
//   MetaAPI - الاتصال وتنفيذ الصفقات
// ════════════════════════════════════════════
async function connectMetaAPI() {
  if (!META_TOKEN || !META_ACCOUNT_ID) {
    log('⚠️ META_TOKEN / META_ACCOUNT_ID غير موجود'); return null;
  }
  try {
    log('🔌 جاري الاتصال بـ MetaAPI...');
    const api     = new MetaApi(META_TOKEN);
    const account = await api.metatraderAccountApi.getAccount(META_ACCOUNT_ID);

    const state = account.state;
    log(`📊 حالة الحساب: ${state}`);

    if (state === 'UNDEPLOYED' || state === 'UNDEPLOYING') {
      log('🚀 جاري نشر الحساب...');
      await account.deploy();
    }
    await account.waitConnected();

    const conn = account.getRPCConnection();
    await conn.connect();
    await conn.waitSynchronized({ timeoutInSeconds: 60 });

    const info = await conn.getAccountInformation();
    log(`✅ MetaAPI متصل! الرصيد: ${info.balance} ${info.currency}`);
    return conn;

  } catch (err) {
    log('❌ MetaAPI خطأ: ' + err.message);
    return null;
  }
}

async function executeTrade(signal) {
  // ── محاولة عبر SDK أولاً ──
  if (metaConn) {
    try {
      const isBuy = signal.direction === 'BUY';
      let result;
      if (isBuy) {
        result = await metaConn.createMarketBuyOrder(
          signal.symbol, LOT_SIZE,
          signal.sl  || undefined,
          signal.tp1 || undefined,
          { comment: 'WhatsApp Bot' }
        );
      } else {
        result = await metaConn.createMarketSellOrder(
          signal.symbol, LOT_SIZE,
          signal.sl  || undefined,
          signal.tp1 || undefined,
          { comment: 'WhatsApp Bot' }
        );
      }
      log(`✅ صفقة منفذة عبر SDK: ${JSON.stringify(result)}`);
      return true;
    } catch (err) {
      log('⚠️ SDK خطأ، جاري المحاولة عبر REST: ' + err.message);
    }
  }

  // ── fallback: REST API ──
  return await executeTradeREST(signal);
}

async function executeTradeREST(signal) {
  if (!META_TOKEN || !META_ACCOUNT_ID) { log('❌ لا يوجد META credentials'); return false; }
  try {
    const https = require('https');
    const type  = signal.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
    const bodyObj = {
      actionType: type,
      symbol:     signal.symbol,
      volume:     LOT_SIZE,
    };
    if (signal.sl)  bodyObj.stopLoss   = signal.sl;
    if (signal.tp1) bodyObj.takeProfit = signal.tp1;

    const body = JSON.stringify(bodyObj);
    log(`📤 REST صفقة: ${signal.symbol} ${signal.direction} LOT=${LOT_SIZE}`);

    // جرب endpoint مناطق مختلفة
    const endpoints = [
      'mt-client-api-v1.agiliumtrade.ai',
      'mt-client-api-v1.new-york.agiliumtrade.ai',
      'mt-client-api-v1.london.agiliumtrade.ai',
    ];

    for (const hostname of endpoints) {
      const ok = await new Promise((resolve) => {
        const options = {
          hostname,
          path:    `/users/current/accounts/${META_ACCOUNT_ID}/trade`,
          method:  'POST',
          headers: {
            'Content-Type':   'application/json',
            'auth-token':     META_TOKEN,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            log(`REST [${hostname}] ${res.statusCode}: ${data.substring(0, 120)}`);
            resolve(res.statusCode >= 200 && res.statusCode < 300);
          });
        });
        req.on('error',   () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(body);
        req.end();
      });
      if (ok) return true;
    }
    log('❌ فشل جميع endpoints');
    return false;
  } catch (err) {
    log('❌ executeTradeREST: ' + err.message);
    return false;
  }
}

// ════════════════════════════════════════════
//   Express - صفحة الحالة وعرض QR
// ════════════════════════════════════════════
const app = express();
app.get('/', async (req, res) => {
  if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    res.send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="UTF-8"><title>QR Code</title>
<meta http-equiv="refresh" content="15">
<style>body{font-family:Arial;text-align:center;padding:30px;background:#f0f2f5}
h2{color:#128c7e}img{border:4px solid #128c7e;border-radius:12px;padding:10px;background:#fff}</style>
</head><body>
<h2>🤖 امسح QR بواتساب</h2>
<p>واتساب ← ⋮ ← الأجهزة المرتبطة ← ربط جهاز</p>
<img src="${img}" width="280"/><br><small>يتحدث كل 15 ثانية</small>
</body></html>`);
  } else {
    const metaStatus = metaConn ? '✅ متصل' : (META_TOKEN ? '⏳ يحاول الاتصال' : '❌ غير مفعّل');
    res.send(`<!DOCTYPE html>
<html dir="rtl"><head><meta charset="UTF-8"><title>Bot Status</title>
<meta http-equiv="refresh" content="30">
<style>body{font-family:Arial;text-align:center;padding:40px;background:#f0f2f5}
.box{background:#fff;border-radius:16px;padding:24px;max-width:400px;margin:auto;box-shadow:0 4px 16px #0002}
.ok{color:#25d366;font-size:52px} h2{color:#128c7e}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:15px}</style>
</head><body>
<div class="box">
<div class="ok">✅</div>
<h2>البوت يعمل</h2>
<div class="row"><span>📱 واتساب</span><span>متصل</span></div>
<div class="row"><span>📊 MetaAPI</span><span>${metaStatus}</span></div>
<div class="row"><span>👤 المرسل</span><span>${TRUSTED_SENDER || 'الكل'}</span></div>
<div class="row"><span>💼 اللوت</span><span>${LOT_SIZE}</span></div>
<div class="row"><span>📅 صفقات اليوم</span><span>${dailyTrades} / ${MAX_TRADES_PER_DAY}</span></div>
</div></body></html>`);
  }
});
app.listen(PORT, () => log(`🌐 Server: http://localhost:${PORT}`));

// ════════════════════════════════════════════
//   واتساب Baileys
// ════════════════════════════════════════════
async function startWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    version,
    auth:              state,
    printQRInTerminal: true,
    browser:           ['MT4 Bot', 'Chrome', '120.0'],
    connectTimeoutMs:  60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs:   30000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      log('📱 QR جاهز');
    }
    if (connection === 'open') {
      currentQR = null;
      log('✅ واتساب متصل!');
      if (!metaConn) {
        metaConn = await connectMetaAPI();
        if (!metaConn) {
          log('⚠️ MetaAPI لم يتصل - سيعيد المحاولة بعد دقيقة');
          setTimeout(async () => { metaConn = await connectMetaAPI(); }, 60000);
        }
      }
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : 0;
      log(`🔌 انقطع الاتصال (${statusCode})`);
      if (statusCode !== DisconnectReason.loggedOut) {
        log('🔄 إعادة الاتصال بعد 5 ثوان...');
        setTimeout(startWhatsApp, 5000);
      } else {
        log('🚪 تم تسجيل الخروج - سيطلب QR جديد');
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
          || msg.message?.imageMessage?.caption
          || '';
        if (!body.trim()) continue;

        // فحص المرسل - يدعم الرسائل المباشرة والجروبات
        const rawSender = (msg.key.participant || msg.key.remoteJid || '');
        const senderNum = rawSender.replace(/[^0-9]/g, '');

        if (TRUSTED_SENDER) {
          const match = senderNum.endsWith(TRUSTED_SENDER) || senderNum.includes(TRUSTED_SENDER);
          if (!match) continue;
        }

        log(`📩 [${senderNum}]: ${body.substring(0, 120)}`);

        const signal = parser.parse(body);
        if (!signal) { log('ℹ️ ليست توصية'); continue; }

        log(`🔍 توصية مكتشفة: ${signal.symbol} ${signal.direction}`);
        log(parser.format(signal));

        checkReset();

        if (signal.action === 'OPEN') {
          if (dailyTrades >= MAX_TRADES_PER_DAY) {
            log(`⛔ الحد اليومي (${MAX_TRADES_PER_DAY}) وصلنا`); continue;
          }
          const ok = await executeTrade(signal);
          if (ok) {
            dailyTrades++;
            log(`🎯 تم! صفقات اليوم: ${dailyTrades}/${MAX_TRADES_PER_DAY}`);
          }
        }

      } catch (err) {
        log('❌ خطأ في معالجة الرسالة: ' + err.message);
      }
    }
  });
}

// ── بدء التشغيل ──
log('🚀 بدء تشغيل البوت...');
startWhatsApp().catch(err => { log('❌ خطأ فادح: ' + err.message); process.exit(1); });
