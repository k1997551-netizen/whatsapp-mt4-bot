
// =============================================
//   محلل التوصيات - يدعم صيغة بشار المجرفي
//   مثال: GBPCAD sell @1.86090
//         Tp1 1.85950
//         Sl  1.86810 -5.10$
// =============================================

class SignalParser {

  constructor() {
    this.symbolMap = {
      'GOLD': 'XAUUSD', 'ذهب': 'XAUUSD', 'الذهب': 'XAUUSD',
      'SILVER': 'XAGUSD', 'فضة': 'XAGUSD',
      'OIL': 'USOIL', 'نفط': 'USOIL',
      'BTC': 'BTCUSD', 'بيتكوين': 'BTCUSD',
      'ETH': 'ETHUSD',
      'SP500': 'US500', 'DJ': 'US30',
      'NAS': 'US100', 'NASDAQ': 'US100',
    };
  }

  parse(messageText) {
    const text = messageText.trim();
    if (text.length < 5) return null;

    const closeSignal = this.parseCloseSignal(text);
    if (closeSignal) return closeSignal;

    return this.parseOpenSignal(text);
  }

  parseCloseSignal(text) {
    if (!/close|إغلاق|اغلاق|أغلق|سكر/i.test(text)) return null;
    return {
      action: 'CLOSE',
      symbol: this.extractSymbol(text) || 'ALL',
      rawMessage: text,
      timestamp: new Date().toISOString(),
    };
  }

  parseOpenSignal(text) {
    const symbol    = this.extractSymbol(text);
    if (!symbol) return null;

    const direction = this.extractDirection(text);
    if (!direction) return null;

    const entry   = this.extractEntry(text);
    const sl      = this.extractSL(text);
    const targets = this.extractTargets(text);

    // قبول التوصية حتى لو ما في SL — بشار أحياناً ما يحدد SL
    if (!targets.length && !sl) return null;

    return {
      action: 'OPEN',
      symbol,
      direction,
      entry,
      sl,
      tp1: targets[0] || null,
      tp2: targets[1] || null,
      tp3: targets[2] || null,
      tp4: targets[3] || null,
      tp5: targets[4] || null,
      tp6: targets[5] || null,
      rawMessage: text,
      timestamp: new Date().toISOString(),
      isValid: true,
    };
  }

  extractSymbol(text) {
    const upperText = text.toUpperCase();

    // قاموس الأسماء العربية والمختصرة
    for (const [key, val] of Object.entries(this.symbolMap)) {
      if (upperText.includes(key.toUpperCase())) return val;
    }

    // أزواج الفوركس الشائعة - صيغة XXXYYY أو XXX/YYY
    const forexPattern = /\b(XAU\/?USD|XAG\/?USD|EUR\/?USD|GBP\/?USD|GBP\/?NZD|GBP\/?CAD|GBP\/?AUD|GBP\/?JPY|GBP\/?CHF|EUR\/?GBP|EUR\/?JPY|EUR\/?CAD|EUR\/?AUD|EUR\/?CHF|EUR\/?NZD|USD\/?JPY|USD\/?CAD|USD\/?CHF|USD\/?SGD|AUD\/?USD|AUD\/?JPY|AUD\/?CAD|AUD\/?NZD|AUD\/?CHF|NZD\/?USD|NZD\/?JPY|NZD\/?CAD|CAD\/?JPY|CAD\/?CHF|CHF\/?JPY|US\d{2,3}|BTC\/?USD|ETH\/?USD|US\s?OIL|USOIL|CRUDE)\b/i;

    const m = text.match(forexPattern);
    if (m) return m[1].replace('/', '').toUpperCase();

    return null;
  }

  extractDirection(text) {
    if (/\bBUY\b|شراء|📈|🟢|⬆/i.test(text)) return 'BUY';
    if (/\bSELL\b|بيع|📉|🔴|⬇/i.test(text))  return 'SELL';
    return null;
  }

  extractEntry(text) {
    // صيغة بشار: SYMBOL buy/sell @PRICE
    const basharPattern = /(?:buy|sell)\s*@\s*([\d.]+)/i;
    const m = text.match(basharPattern);
    if (m) return parseFloat(m[1]);

    // صيغ أخرى
    const patterns = [
      /entry[:\s@]*([\d.]+)/i,
      /enter[:\s@]*([\d.]+)/i,
      /دخول[:\s]*([\d.]+)/i,
      /price[:\s]*([\d.]+)/i,
      /سعر[:\s]*([\d.]+)/i,
      /@\s*([\d.]+)/,
    ];
    for (const p of patterns) {
      const match = text.match(p);
      if (match) return parseFloat(match[1]);
    }
    return null;
  }

  extractSL(text) {
    // صيغة بشار: Sl  1.86810 -5.10$  أو  Sl: 1.86810
    const patterns = [
      /\bSl\s+([\d.]+)/i,
      /\bSL\s*[:\-]?\s*([\d.]+)/i,
      /stop\s*loss[:\s]*([\d.]+)/i,
      /وقف[:\s]*([\d.]+)/i,
      /stoploss[:\s]*([\d.]+)/i,
      /s\.l[:\s]*([\d.]+)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }

  extractTargets(text) {
    const targets = [];

    // صيغة بشار: Tp1 1.85950  أو  Tp2 1.85750  إلخ
    const tpPattern = /Tp\s*(\d+)\s+([\d.]+)/gi;
    const matches = [];
    let match;
    while ((match = tpPattern.exec(text)) !== null) {
      matches.push({ num: parseInt(match[1]), price: parseFloat(match[2]) });
    }
    if (matches.length) {
      matches.sort((a, b) => a.num - b.num);
      return matches.map(m => m.price);
    }

    // صيغة TP: أو Target:
    const altPattern = /(?:TP|T\.P|target|take\s*profit|هدف)[:\s]*([\d.]+)/gi;
    while ((match = altPattern.exec(text)) !== null) {
      targets.push(parseFloat(match[1]));
    }

    return targets;
  }

  format(signal) {
    if (!signal) return '❌ لم يتم التعرف على التوصية';
    if (signal.action === 'CLOSE') return `🔴 إغلاق: ${signal.symbol}`;

    const emoji = signal.direction === 'BUY' ? '📈🟢' : '📉🔴';
    const tps = [signal.tp1, signal.tp2, signal.tp3, signal.tp4, signal.tp5, signal.tp6]
      .filter(Boolean)
      .map((tp, i) => `🎯 TP${i+1}: ${tp}`)
      .join('\n');
    return [
      `${emoji} ${signal.symbol} ${signal.direction}`,
      signal.entry ? `📌 دخول: ${signal.entry}` : '📌 دخول: فوري',
      signal.sl    ? `🛑 SL: ${signal.sl}` : '🛑 SL: غير محدد',
      tps,
    ].filter(Boolean).join('\n');
  }
}

module.exports = SignalParser;
