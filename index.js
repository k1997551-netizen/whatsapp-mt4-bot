
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }     = require('@hapi/boom');
const express      = require('express');
const qrcode       = require('qrcode');
const https        = require('https');
const SignalParser = require('./signalParser');

const TRUSTED_SENDER     = (process.env.TRUSTED_SENDER || '').replace(/[^0-9]/g, '');
const LOT_SIZE           = parseFloat(process.env.LOT_SIZE || '0.01');
const MAX_TRADES_PER_DAY = parseInt(process.env.MAX_TRADES_PER_DAY || '10');
const META_TOKEN         = process.env.META_TOKEN || '';
const META_ACCOUNT_ID    = process.env.META_ACCOUNT_ID || '';
const PORT               = process.env.PORT || 3000;

const parser      = new SignalParser();
let   currentQR   = null;
let   dailyTrades = 0;
let   lastDate    = new Date().toDateString();
let   metaStatus  = 'غير متصل';
let   tradeLog    = [];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
}

function checkReset() {
  const today = new Date().toDateString();
  if (today !== lastDate) { dailyTrades = 0; lastDate = today; }
}

// ── تنفيذ الصفقة عبر MetaAPI REST ─────────────────
function doRequest(opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function checkMetaAPI() {
  if (!META_TOKEN || !META_ACCOUNT_ID) {
    metaStatus = 'غير مفعّل';
    return false;
  }
  const opts = {
    hostname: 'mt-provisioning-api-v1.agiliumtrade.ai',
    path: `/users/current/accounts/${META_ACCOUNT_ID}`,
    method: 'GET',
    headers: { 'auth-token': META_TOKEN },
    timeout: 10000,
  };
  const res = await doRequest(opts);
  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      metaStatus = data.connectionStatus === 'CONNECTED' ? '✅ متصل' :
                   data.state === 'DEPLOYED' ? '⏳ ينتظر MT4' :
                   data.state || 'غير معروف';
      log(`MetaAPI: state=${data.state} connection=${data.connectionStatus}`);
      return data.connectionStatus === 'CONNECTED';
    } catch(e) { metaStatus = 'خطأ'; return false; }
  }
  metaStatus = `خطأ ${res.status}`;
  log(`MetaAPI check failed: ${res.status} - ${res.body.substring(0,100)}`);
  return false;
}

async function executeTrade(signal) {
  if (!META_TOKEN || !META_ACCOUNT_ID) {
    log('❌ لا يوجد META_TOKEN أو META_ACCOUNT_ID'); return false;
  }

  const type = signal.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL';
  const bodyObj = { actionType: type, symbol: signal.symbol, volume: LOT_SIZE };
  if (signal.sl)  bodyObj.stopLoss   = signal.sl;
  if (signal.tp1) bodyObj.takeProfit = signal.tp1;
  const body = JSON.stringify(bodyObj);

  log(`📤 تنفيذ: ${signal.symbol} ${signal.direction} LOT=${LOT_SIZE} SL=${signal.sl} TP=${signal.tp1}`);

  // جرب عدة endpoints
  const hosts = [
    'mt-client-api-v1.agiliumtrade.ai',
    'mt-client-api-v1.new-york.agiliumtrade.ai',
    'mt-client-api-v1.london.agiliumtrade.ai',
    'mt-client-api-v1.singapore.agiliumtrade.ai',
  ];

  for (const hostname of hosts) {
    const opts = {
      hostname,
      path: `/users/current/accounts/${META_ACCOUNT_ID}/trade`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'auth-token': META_TOKEN,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    };
    const res = await doRequest(opts, body);
    log(`[${hostname}] ${res.status}: ${res.body.substring(0,120)}`);
    if (res.status >= 200 && res.status < 300) {
      metaStatus = '✅ متصل';
      return true;
    }
    if (res.status === 401) { log('❌ Token خاطئ'); metaStatus = '❌ Token خاطئ'; return false; }
    if (res.status === 404) { log('❌ Account ID خاطئ'); metaStatus = '❌ Account ID خاطئ'; return false; }
  }
  return false;
}

// ── Express ───────────────────────────────────────
const app = express();
app.get('/', async (req, res) => {
  if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    res.send(`<!DOCTYPE html><html dir="rtl">
<head><meta charset="UTF-8"><title>QR</title><meta http-equiv="refresh" content="15">
<style>body{font-family:Arial;text-align:center;padding:30px;background:#f0f2f5}
h2{color:#128c7e}img{border:4px solid #128c7e;border-radius:12px;padding:10px;background:#fff}</style>
</head><body>
<h2>🤖 امسح QR بواتساب</h2>
<p>واتساب ← ⋮ ← الأجهزة المرتبطة ← ربط جهاز</p>
<img src="${img}" width="280"/>
<p><small>تحديث تلقائي كل 15 ثانية</small></p>
</body></html>`);
  } else {
    const logs = tradeLog.slice(-10).reverse().map(t =>
      `<div style="padding:6px;border-bottom:1px solid #eee;font-size:13px">${t}</div>`
    ).join('') || '<div style="color:#999">لا توجد صفقات بعد</div>';

    res.send(`<!DOCTYPE html><html dir="rtl">
<head><meta charset="UTF-8"><title>Bot</title><meta http-equiv="refresh" content="20">
<style>body{font-family:Arial;text-align:center;padding:20px;background:#f0f2f5}
.box{background:#fff;border-radius:16px;padding:20px;max-width:420px;margin:auto;box-shadow:0 4px 16px #0002}
.row{display:flex;justify-content:space-between;padding:8px 4px;border-bottom:1px solid #eee}
h2{color:#128c7e}.logs{text-align:right;margin-top:16px}</style>
</head><body><div class="box">
<h2>🤖 البوت يعمل ✅</h2>
<div class="row"><span>📱 واتساب</span><span style="color:green">متصل</span></div>
<div class="row"><span>📊 MetaAPI</span><span>${metaStatus}</span></div>
<div class="row"><span>👤 المرسل</span><span>${TRUSTED_SENDER || 'الكل'}</span></div>
<div class="row"><span>💼 اللوت</span><span>${LOT_SIZE}</span></div>
<div class="row"><span>📅 صفقات اليوم</span><span>${dailyTrades} / ${MAX_TRADES_PER_DAY}</span></div>
<div class="logs"><b>آخر الصفقات:</b>${logs}</div>
</div></body></html>`);
  }
});

app.get('/status', async (req, res) => {
  await checkMetaAPI();
  res.json({ whatsapp: 'connected', metaapi: metaStatus, trades: dailyTrades });
});

app.listen(PORT, () => log(`🌐 Server: port ${PORT}`));

// تحقق من MetaAPI كل 5 دقائق
setInterval(checkMetaAPI, 5 * 60 * 1000);
checkMetaAPI();

// ── واتساب ────────────────────────────────────────
async function startWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['MT4 Bot', 'Chrome', '120.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; log('📱 QR جاهز'); }
    if (connection === 'open') {
      currentQR = null;
      log('✅ واتساب متصل!');
      checkMetaAPI();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : 0;
      log(`🔌 انقطع (${code})`);
      const retry = code !== DisconnectReason.loggedOut;
      setTimeout(startWhatsApp, retry ? 5000 : 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const body = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption || '';
        if (!body.trim()) continue;

        const rawSender = msg.key.participant || msg.key.remoteJid || '';
        const senderNum = rawSender.replace(/[^0-9]/g, '');

        if (TRUSTED_SENDER && !senderNum.endsWith(TRUSTED_SENDER) && !senderNum.includes(TRUSTED_SENDER)) continue;

        log(`📩 [${senderNum}]: ${body.substring(0, 100)}`);

        const signal = parser.parse(body);
        if (!signal) { log('ℹ️ ليست توصية'); continue; }

        log(`🔍 ${signal.symbol} ${signal.direction} | دخول:${signal.entry} SL:${signal.sl} TP1:${signal.tp1}`);

        checkReset();
        if (signal.action === 'OPEN') {
          if (dailyTrades >= MAX_TRADES_PER_DAY) { log('⛔ الحد اليومي'); continue; }
          const ok = await executeTrade(signal);
          if (ok) {
            dailyTrades++;
            const entry = `✅ ${new Date().toLocaleTimeString('ar')} | ${signal.symbol} ${signal.direction} | LOT ${LOT_SIZE}`;
            tradeLog.push(entry);
            log(`🎯 صفقة منفذة! اليوم: ${dailyTrades}/${MAX_TRADES_PER_DAY}`);
          } else {
            log('❌ فشل تنفيذ الصفقة - شوف Logs للتفاصيل');
          }
        }
      } catch (err) { log('❌ ' + err.message); }
    }
  });
}

log('🚀 تشغيل البوت...');
startWhatsApp().catch(err => { log('❌ ' + err.message); process.exit(1); });
