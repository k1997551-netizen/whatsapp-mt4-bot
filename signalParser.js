class SignalParser {
  constructor() {
    this.symbolMap = {
      "GOLD": "XAUUSD", "ذهب": "XAUUSD", "الذهب": "XAUUSD",
      "SILVER": "XAGUSD", "فضة": "XAGUSD",
      "OIL": "USOIL", "نفط": "USOIL",
      "BTC": "BTCUSD", "بيتكوين": "BTCUSD",
      "ETH": "ETHUSD", "NAS": "US100", "NASDAQ": "US100",
      "SP500": "US500", "DJ": "US30"
    };
  }

  parse(text) {
    if (!text || text.length < 8) return null;
    const close = this.parseClose(text);
    if (close) return close;
    return this.parseOpen(text);
  }

  parseClose(text) {
    if (!/close|إغلاق|اغلاق|أغلق|سكر/i.test(text)) return null;
    return { action: "CLOSE", symbol: this.extractSymbol(text) || "ALL", timestamp: new Date().toISOString() };
  }

  parseOpen(text) {
    const symbol = this.extractSymbol(text);
    if (!symbol) return null;
    const direction = this.extractDirection(text);
    if (!direction) return null;
    const sl = this.extractSL(text);
    const targets = this.extractTargets(text);
    if (!sl && !targets.length) return null;
    return {
      action: "OPEN", symbol, direction,
      entry: this.extractEntry(text), sl,
      tp1: targets[0] || null, tp2: targets[1] || null, tp3: targets[2] || null,
      timestamp: new Date().toISOString(), isValid: true
    };
  }

  extractSymbol(text) {
    const upper = text.toUpperCase();
    for (const [key, val] of Object.entries(this.symbolMap)) {
      if (upper.includes(key.toUpperCase())) return val;
    }
    const patterns = [/\b(XAU\/?USD)\b/i,/\b(EUR\/?USD)\b/i,/\b(GBP\/?USD)\b/i,
      /\b(USD\/?JPY)\b/i,/\b(AUD\/?USD)\b/i,/\b(US\d{2,3})\b/i,/\b(BTC\/?USD)\b/i];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].replace("/","").toUpperCase();
    }
    return null;
  }

  extractDirection(text) {
    if (/\bBUY\b|شراء|📈|🟢/i.test(text)) return "BUY";
    if (/\bSELL\b|بيع|📉|🔴/i.test(text)) return "SELL";
    if (/BUY\s+LIMIT/i.test(text)) return "BUY_LIMIT";
    if (/SELL\s+LIMIT/i.test(text)) return "SELL_LIMIT";
    return null;
  }

  extractEntry(text) {
    const m = text.match(/(?:entry|دخول|enter|@|price|سعر)[:\s@]*([\d.]+)/i);
    return m ? parseFloat(m[1]) : null;
  }

  extractSL(text) {
    const m = text.match(/(?:sl|stop.?loss|وقف|s\.l)[:\s@]*([\d.]+)/i);
    return m ? parseFloat(m[1]) : null;
  }

  extractTargets(text) {
    const targets = [];
    const p = /tp\s*\d*[:\s@]*([\d.]+)/gi;
    let m;
    while ((m = p.exec(text)) !== null) targets.push(parseFloat(m[1]));
    if (!targets.length) {
      const p2 = /(?:target|هدف|take.?profit)[:\s]*([\d.]+)/gi;
      while ((m = p2.exec(text)) !== null) targets.push(parseFloat(m[1]));
    }
    return targets;
  }

  format(signal) {
    if (!signal) return "❌ ليست توصية";
    if (signal.action === "CLOSE") return "🔴 إغلاق: " + signal.symbol;
    const e = signal.direction === "BUY" ? "📈🟢" : "📉🔴";
    return [e + " " + signal.symbol + " " + signal.direction,
      signal.entry ? "📌 دخول: " + signal.entry : "📌 دخول: فوري",
      signal.sl ? "🛑 SL: " + signal.sl : "",
      signal.tp1 ? "🎯 TP1: " + signal.tp1 : "",
      signal.tp2 ? "🎯 TP2: " + signal.tp2 : "",
      signal.tp3 ? "🎯 TP3: " + signal.tp3 : ""
    ].filter(Boolean).join("\n");
  }
}

module.exports = SignalParser;
