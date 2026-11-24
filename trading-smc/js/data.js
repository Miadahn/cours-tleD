/*
 * Sources de données : Binance (API publique, sans clé), fichier CSV, démo.
 * Toutes renvoient des bougies { time (s, UTC), open, high, low, close, volume }.
 */
(function (root) {
  'use strict';

  const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  // Unité de temps supérieure utilisée pour le biais (analyse multi-timeframe)
  const HTF = { '1m': '15m', '5m': '1h', '15m': '4h', '30m': '4h', '1h': '1d', '4h': '1d', '1d': '1w', '1w': '1w' };

  const BINANCE_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

  async function fetchBinance(symbol, interval, limit = 1000) {
    const params = `symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${limit}`;
    let lastErr;
    for (const host of BINANCE_HOSTS) {
      try {
        const res = await fetch(`${host}/api/v3/klines?${params}`);
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Binance ${res.status} : ${body.slice(0, 120)}`);
        }
        const rows = await res.json();
        return rows.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
        }));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Binance injoignable');
  }

  // ---------------------------------------------------------------------------
  // CSV : TradingView, MetaTrader (date et heure séparées), exports génériques
  // ---------------------------------------------------------------------------
  function parseTime(str) {
    const s = String(str).trim().replace(/^"|"$/g, '');
    if (/^\d+(\.\d+)?$/.test(s)) {
      const v = +s;
      return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    // 2024.01.02 13:00 | 2024-01-02 13:00:00 | 2024-01-02T13:00:00Z
    let iso = s.replace(/^(\d{4})[./](\d{2})[./](\d{2})/, '$1-$2-$3').replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += (iso.includes('T') ? '' : 'T00:00') + 'Z';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
      // 02/01/2024 13:00 (jour/mois/année)
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
      if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0)) / 1000;
      return NaN;
    }
    return Math.floor(t / 1000);
  }

  function parseCSV(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Fichier vide');
    const sep = [';', '\t', ','].find((s) => lines[0].split(s).length >= 5) || ',';
    let header = null;
    const first = lines[0].split(sep).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase());
    if (first.some((x) => /open|high|low|close|time|date/.test(x))) {
      header = first;
      lines.shift();
    }
    const idx = (names, fallback) => {
      if (!header) return fallback;
      const i = header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
      return i >= 0 ? i : fallback;
    };
    const out = [];
    for (const line of lines) {
      let cols = line.split(sep).map((x) => x.trim());
      // MetaTrader : date et heure dans deux colonnes séparées
      if (!header && /^\d{1,2}:\d{2}/.test(cols[1] || '')) cols = [cols[0] + ' ' + cols[1], ...cols.slice(2)];
      let iT = idx(['time', 'date', 'timestamp', 'datetime'], 0);
      let iO = idx(['open', 'o'], 1);
      let iH = idx(['high', 'h'], 2);
      let iL = idx(['low', 'l'], 3);
      let iC = idx(['close', 'c'], 4);
      let iV = idx(['volume', 'vol', 'tick'], 5);
      if (header && header[0] === 'date' && header[1] === 'time') {
        cols = [cols[0] + ' ' + cols[1], ...cols.slice(2)];
        iT = 0; iO -= 1; iH -= 1; iL -= 1; iC -= 1; iV -= 1;
      }
      const b = {
        time: parseTime(cols[iT]),
        open: parseFloat(cols[iO]), high: parseFloat(cols[iH]),
        low: parseFloat(cols[iL]), close: parseFloat(cols[iC]),
        volume: parseFloat(cols[iV]) || 0,
      };
      if ([b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)) out.push(b);
    }
    if (out.length < 20) throw new Error('Format CSV non reconnu (colonnes attendues : time, open, high, low, close)');
    return normalize(out);
  }

  /** Tri chronologique + suppression des doublons. */
  function normalize(c) {
    c.sort((a, b) => a.time - b.time);
    const out = [];
    for (const b of c) {
      if (out.length && out[out.length - 1].time === b.time) out[out.length - 1] = b;
      else out.push(b);
    }
    return out;
  }

  function detectTimeframe(c) {
    if (c.length < 3) return '1h';
    const diffs = [];
    for (let i = 1; i < Math.min(c.length, 200); i++) diffs.push(c[i].time - c[i - 1].time);
    diffs.sort((a, b) => a - b);
    const d = diffs[Math.floor(diffs.length / 2)];
    let best = '1h';
    let bestErr = Infinity;
    for (const [tf, s] of Object.entries(TF_SECONDS)) {
      const err = Math.abs(Math.log(d / s));
      if (err < bestErr) { bestErr = err; best = tf; }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Données de démonstration (marche aléatoire avec tendances et impulsions)
  // ---------------------------------------------------------------------------
  function demoCandles(interval = '15m', count = 1000, seed = 42) {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const step = TF_SECONDS[interval] || 900;
    const end = Math.floor(Date.now() / 1000 / step) * step;
    let price = 65000;
    let drift = 0;
    const vol = 0.0025 * Math.sqrt(step / 900);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i % 60 === 0) drift = (rnd() - 0.5) * vol * 0.5;
      const impulse = rnd() < 0.03 ? (rnd() - 0.5) * vol * 8 : 0;
      const open = price;
      const ret = drift + (rnd() - 0.5) * vol * 2 + impulse;
      const close = open * (1 + ret);
      const high = Math.max(open, close) * (1 + rnd() * vol);
      const low = Math.min(open, close) * (1 - rnd() * vol);
      out.push({ time: end - (count - 1 - i) * step, open, high, low, close, volume: 100 + rnd() * 900 });
      price = close;
    }
    return out;
  }

  const Data = { TF_SECONDS, HTF, fetchBinance, parseCSV, parseTime, normalize, detectTimeframe, demoCandles };
  root.SMCData = Data;
  if (typeof module !== 'undefined' && module.exports) module.exports = Data;
})(typeof window !== 'undefined' ? window : globalThis);
