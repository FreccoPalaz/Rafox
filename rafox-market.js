/* =====================================================================
   rafox-market.js — modulo dati di mercato condiviso fra sito e app.
   Nessuna chiave API. Endpoint pubblici Binance.
   Uso:
     RafoxMarket.start({ symbols:['BTCUSDT',...], kline:{symbol:'BTCUSDT', interval:'1h'} });
     RafoxMarket.on('price',  ({symbol, price, pct, ...}) => ...);
     RafoxMarket.on('kline',  ({symbol, interval, candle, closed}) => ...);
     RafoxMarket.on('status', ({state, text}) => ...);
   ===================================================================== */
(function (global) {
  'use strict';

  const ASSETS = [
    { sym:'BTCUSDT',  label:'BTC/USDT',  short:'BTC',  name:'Bitcoin',           dp:2 },
    { sym:'ETHUSDT',  label:'ETH/USDT',  short:'ETH',  name:'Ethereum',          dp:2 },
    { sym:'SOLUSDT',  label:'SOL/USDT',  short:'SOL',  name:'Solana',            dp:2 },
    { sym:'BNBUSDT',  label:'BNB/USDT',  short:'BNB',  name:'BNB',               dp:2 },
    { sym:'XRPUSDT',  label:'XRP/USDT',  short:'XRP',  name:'XRP',               dp:4 },
    { sym:'ADAUSDT',  label:'ADA/USDT',  short:'ADA',  name:'Cardano',           dp:4 },
    { sym:'AVAXUSDT', label:'AVAX/USDT', short:'AVAX', name:'Avalanche',         dp:3 },
    { sym:'LINKUSDT', label:'LINK/USDT', short:'LINK', name:'Chainlink',         dp:3 },
    { sym:'DOGEUSDT', label:'DOGE/USDT', short:'DOGE', name:'Dogecoin',          dp:5 },
    { sym:'PAXGUSDT', label:'PAXG/USDT', short:'PAXG', name:'Oro tokenizzato',   dp:2 },
    { sym:'EURUSDT',  label:'EUR/USDT',  short:'EUR',  name:'Euro',              dp:4 }
  ];

  // data-api.binance.vision è l'endpoint dedicato ai dati pubblici: non richiede
  // chiave e non soffre delle restrizioni geografiche di api.binance.com.
  const REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
  const WSS  = ['wss://data-stream.binance.vision/stream', 'wss://stream.binance.com:9443/stream'];

  // Due sorgenti per la libreria dei grafici: se cdnjs è bloccato dalla rete
  // o da un ad-blocker, si tenta automaticamente unpkg.
  const CHART_LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/lightweight-charts/4.1.3/lightweight-charts.standalone.production.js',
    'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js'
  ];

  function loadScript(urls) {
    return new Promise((resolve, reject) => {
      let i = 0;
      (function next() {
        if (i >= urls.length) return reject(new Error('nessuna sorgente disponibile per lo script'));
        const s = document.createElement('script');
        s.src = urls[i++];
        s.onload = () => resolve();
        s.onerror = next;
        document.head.appendChild(s);
      })();
    });
  }

  function loadChartLib() {
    if (typeof window.LightweightCharts !== 'undefined') return Promise.resolve();
    return loadScript(CHART_LIBS);
  }

  /* =====================================================================
     BACKTEST — statistiche calcolate su candele storiche reali di Binance,
     non simulazioni sintetiche. Ogni profilo di rischio applica una
     strategia di RIFERIMENTO dichiarata (incrocio di medie mobili
     esponenziali, con eventuale stop-loss), non necessariamente la logica
     esatta che il bot userà in produzione — va presentata come tale.
     ===================================================================== */
  const BOT_PROFILES = {
    conservativo: {
      symbols: ['BTCUSDT'],
      fast: 50, slow: 200,        // EMA lente: pochi segnali, trend di fondo
      trendMinATR: 0.8,           // entra solo se le EMA si separano di almeno 0.8×ATR (filtra i falsi segnali deboli)
      trailPct: 10, feePct: 0.1,
      label: 'EMA50/200 su BTC, filtro trend ≥0.8×ATR, trailing stop 10%'
    },
    moderato: {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      fast: 20, slow: 50,
      trendMinATR: 0.5,
      trailPct: 15, feePct: 0.1,
      label: 'EMA20/50 su BTC+ETH, filtro trend ≥0.5×ATR, trailing stop 15%'
    },
    aggressivo: {
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      fast: 9, slow: 21,          // EMA veloci: molti segnali, molto rumore
      trendMinATR: 0.3,
      trailPct: 20, feePct: 0.1,
      label: 'EMA9/21 su BTC+ETH+SOL, filtro trend ≥0.3×ATR, trailing stop 20%'
    }
  };

  /* Average True Range: misura la volatilità reale (non solo il prezzo),
     usata come metro per giudicare se un incrocio di medie è un segnale
     genuino o solo rumore. */
  function atr(candles, period) {
    const tr = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    return ema(tr, period);
  }

  /* Backtest giornaliero su chiusure e minimi reali. Entra solo quando le EMA
     si separano di almeno trendMinATR volte l'ATR corrente (filtro anti-rumore).
     Una volta dentro, uno stop mobile segue il massimo di chiusura raggiunto:
     esce se il minimo del giorno lo perfora, o se il trend si inverte. */
  function backtestTrend(candles, fast, slow, trendMinATR, trailPct, feePct) {
    const closes = candles.map(c => c.close);
    const ef = ema(closes, fast), es = ema(closes, slow);
    const atrArr = atr(candles, 14);
    const fee = feePct / 100;
    let inPos = false, peak = 0, equity = 1, trades = 0;
    const curve = [equity];
    for (let i = 1; i < candles.length; i++) {
      const gap = atrArr[i - 1] > 0 ? (ef[i - 1] - es[i - 1]) / atrArr[i - 1] : 0;
      const wantLong = gap >= trendMinATR;
      if (!inPos) {
        if (wantLong) { inPos = true; peak = candles[i].close; equity *= (1 - fee); trades++; }
      } else {
        peak = Math.max(peak, candles[i].close);
        const trailPrice = peak * (1 - trailPct / 100);
        const stopped = candles[i].low <= trailPrice;
        const exitPrice = stopped ? trailPrice : candles[i].close;
        equity *= (exitPrice / candles[i - 1].close);
        if (stopped || ef[i - 1] < es[i - 1]) { equity *= (1 - fee); inPos = false; }
      }
      curve.push(equity);
    }
    return { curve, trades };
  }

  function combineCurves(curves) {
    const n = Math.min(...curves.map(c => c.length));
    const daily = curves.map(c => {
      const r = [0];
      for (let i = 1; i < n; i++) r.push(c[i] / c[i - 1] - 1);
      return r;
    });
    const combined = [1];
    for (let i = 1; i < n; i++) {
      const avg = daily.reduce((a, d) => a + d[i], 0) / daily.length;
      combined.push(combined[i - 1] * (1 + avg));
    }
    return combined;
  }

  /* Finestre mobili reali di 365 giorni sulla stessa serie storica:
     ogni finestra è un anno realmente accaduto, non un anno inventato. */
  function rollingWindowStats(curve, windowDays = 365, step = 5) {
    const rets = [], dd = [];
    for (let start = 0; start + windowDays < curve.length; start += step) {
      const seg = curve.slice(start, start + windowDays + 1);
      rets.push(seg[seg.length - 1] / seg[0] - 1);
      let peak = seg[0], maxDD = 0;
      for (const v of seg) { if (v > peak) peak = v; const d = (v - peak) / peak; if (d < maxDD) maxDD = d; }
      dd.push(maxDD);
    }
    return { rets, dd };
  }

  function summarize(rets, dd) {
    const n = rets.length;
    const mean = rets.reduce((a, b) => a + b, 0) / n;
    const sorted = [...rets].sort((a, b) => a - b);
    const median = sorted[Math.floor(n / 2)];
    const winRate = rets.filter(r => r > 0).length / n;
    const avgDD = dd.reduce((a, b) => a + b, 0) / n;
    const probBig = dd.filter(d => d <= -0.20).length / n;
    return { n, mean, median, winRate, avgDD, probBig };
  }

  async function runProfileBacktest(name) {
    const profile = BOT_PROFILES[name];
    if (!profile) throw new Error('profilo sconosciuto: ' + name);
    const perSymbol = {};
    for (const sym of profile.symbols) perSymbol[sym] = await klines(sym, '1d', 2000);
    const curves = profile.symbols.map(sym =>
      backtestTrend(perSymbol[sym], profile.fast, profile.slow, profile.trendMinATR, profile.trailPct, profile.feePct).curve);
    const combined = curves.length > 1 ? combineCurves(curves) : curves[0];

    // scarta il riscaldamento delle EMA lente prima di misurare le finestre
    const warm = Math.min(profile.slow * 2, combined.length - 400);
    const base = combined[warm] || combined[0];
    const trimmed = combined.slice(warm).map(v => v / base);

    const { rets, dd } = rollingWindowStats(trimmed);
    const stats = summarize(rets, dd);
    const first = perSymbol[profile.symbols[0]][0];
    const last = perSymbol[profile.symbols[0]][perSymbol[profile.symbols[0]].length - 1];
    return {
      profile: name, label: profile.label, windows: stats.n,
      meanReturn: stats.mean * 100, medianReturn: stats.median * 100,
      winRate: stats.winRate * 100, avgDrawdown: stats.avgDD * 100,
      probBigDrawdown: stats.probBig * 100,
      fromDays: Math.round((last.time - first.time) / 86400)
    };
  }

  const bySym = Object.fromEntries(ASSETS.map(a => [a.sym, a]));
  const prices = Object.create(null);   // symbol -> ultimo prezzo
  const daily  = Object.create(null);   // symbol -> { pct, high, low, vol }
  const listeners = { price: [], kline: [], status: [] };

  let ws = null, wsIdx = 0, retry = 0, closing = false;
  let cfg = { symbols: [], kline: null };

  /* ---------- formattatori ---------- */
  const fmt = {
    money(n, dp = 2) {
      return n == null || !isFinite(n) ? '—'
        : n.toLocaleString('it-IT', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    },
    signed(n, dp = 2) {
      if (n == null || !isFinite(n)) return '—';
      return (n > 0 ? '+' : n < 0 ? '−' : '') + fmt.money(Math.abs(n), dp);
    },
    pct(n, dp = 2) {
      return n == null || !isFinite(n) ? '—' : fmt.signed(n, dp) + '%';
    },
    compact(n) {
      return n == null || !isFinite(n) ? '—'
        : n.toLocaleString('it-IT', { notation: 'compact', maximumFractionDigits: 1 });
    },
    clock(d = new Date()) {
      const p = x => String(x).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    },
    dp(sym) { return bySym[sym] ? bySym[sym].dp : 2; }
  };

  /* ---------- eventi ---------- */
  function emit(type, payload) {
    for (const fn of listeners[type] || []) {
      try { fn(payload); } catch (e) { console.error('[RafoxMarket]', e); }
    }
  }
  function on(type, fn) {
    (listeners[type] || (listeners[type] = [])).push(fn);
    return () => {
      const i = listeners[type].indexOf(fn);
      if (i > -1) listeners[type].splice(i, 1);
    };
  }
  function status(state, text) { emit('status', { state, text }); }

  /* ---------- REST ---------- */
  async function fetchJSON(path) {
    let last;
    for (const base of REST) {
      try {
        const r = await fetch(base + path, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last || new Error('rete non raggiungibile');
  }

  function mapKlines(raw) {
    return raw.map(k => ({
      time: k[0] / 1000,
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
    }));
  }

  /* Binance restituisce al massimo 1000 candele a chiamata. Per richieste più
     grandi, si scorre all'indietro nel tempo con endTime, ripartendo appena
     prima della candela più vecchia già ottenuta, finché non si raggiungono
     le candele volute o l'inizio reale dello storico del simbolo (alcuni
     asset più recenti hanno meno storico disponibile: in quel caso si
     restituisce tutto quello che esiste, senza errore). */
  async function klines(symbol, interval, limit = 500) {
    if (limit <= 1000) {
      const raw = await fetchJSON(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      return mapKlines(raw);
    }
    let all = [];
    let endTime = Date.now();
    while (all.length < limit) {
      const raw = await fetchJSON(
        `/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=1000`);
      if (!raw.length) break;
      all = mapKlines(raw).concat(all);
      endTime = raw[0][0] - 1;
      if (raw.length < 1000) break; // inizio dello storico reale del simbolo
    }
    return all.length > limit ? all.slice(all.length - limit) : all;
  }

  async function ticker24h(symbols) {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    const q = list.length === 1
      ? `?symbol=${list[0]}`
      : '?symbols=' + encodeURIComponent(JSON.stringify(list));
    const res = await fetchJSON('/api/v3/ticker/24hr' + q);
    const rows = Array.isArray(res) ? res : [res];
    const out = [];
    for (const d of rows) {
      const row = {
        symbol: d.symbol,
        price: +d.lastPrice,
        pct: +d.priceChangePercent,
        high: +d.highPrice,
        low: +d.lowPrice,
        vol: +d.quoteVolume
      };
      prices[d.symbol] = row.price;
      daily[d.symbol] = { pct: row.pct, high: row.high, low: row.low, vol: row.vol };
      out.push(row);
      emit('price', row);
    }
    return out;
  }

  /* ---------- WebSocket ---------- */
  function streamNames() {
    const s = cfg.symbols.map(x => x.toLowerCase() + '@miniTicker');
    if (cfg.kline) {
      s.push(cfg.kline.symbol.toLowerCase() + '@ticker');
      s.push(`${cfg.kline.symbol.toLowerCase()}@kline_${cfg.kline.interval}`);
    }
    return [...new Set(s)].join('/');
  }

  function connect() {
    if (!cfg.symbols.length && !cfg.kline) return;
    closing = false;
    status('wait', retry ? 'Riconnessione…' : 'Connessione…');
    try {
      ws = new WebSocket(WSS[wsIdx % WSS.length] + '?streams=' + streamNames());
    } catch { return scheduleRetry(); }

    ws.onopen = () => { retry = 0; status('live', 'Live'); };

    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const d = msg && msg.data;
      if (!d) return;

      if (d.e === '24hrMiniTicker') {
        const price = +d.c, open = +d.o;
        prices[d.s] = price;
        const pct = open ? (price - open) / open * 100 : null;
        daily[d.s] = Object.assign(daily[d.s] || {}, { pct });
        emit('price', { symbol: d.s, price, pct });
      }
      else if (d.e === '24hrTicker') {
        prices[d.s] = +d.c;
        daily[d.s] = { pct: +d.P, high: +d.h, low: +d.l, vol: +d.q };
        emit('price', {
          symbol: d.s, price: +d.c, pct: +d.P, high: +d.h, low: +d.l, vol: +d.q
        });
      }
      else if (d.e === 'kline') {
        const k = d.k;
        emit('kline', {
          symbol: d.s,
          interval: k.i,
          closed: !!k.x,
          candle: { time: k.t / 1000, open:+k.o, high:+k.h, low:+k.l, close:+k.c, volume:+k.v }
        });
      }
    };

    ws.onclose = () => { if (!closing) scheduleRetry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function scheduleRetry() {
    retry++;
    if (retry % 3 === 0) wsIdx++;           // ruota sull'endpoint alternativo
    const wait = Math.min(1000 * 2 ** Math.min(retry, 5), 30000);
    status('down', `Offline — nuovo tentativo tra ${Math.round(wait / 1000)}s`);
    setTimeout(connect, wait);
  }

  function reconnect() {
    closing = true;
    if (ws) { try { ws.close(); } catch {} }
    connect();
  }

  function start(options) {
    cfg = {
      symbols: (options && options.symbols) || ASSETS.map(a => a.sym),
      kline: (options && options.kline) || null
    };
    reconnect();
  }

  function setKline(symbol, interval) {
    cfg.kline = { symbol, interval };
    reconnect();
  }

  /* ---------- indicatori (per il feed di segnali) ---------- */
  function ema(values, period) {
    if (!values.length) return [];
    const k = 2 / (period + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
  }

  /* =====================================================================
     WALK-FORWARD — separazione netta tra la finestra su cui si SCELGONO
     i parametri e la finestra su cui si GIUDICANO. Le due non si
     sovrappongono mai: i parametri vengono scelti guardando solo i 365
     giorni precedenti, poi congelati e applicati a un periodo successivo
     che la fase di scelta non ha mai visto. Si scorre in avanti e si
     ripete lungo tutto lo storico disponibile.
     ===================================================================== */
  const WALK_TRAIN_DAYS = 365;

  /* Griglie di parametri piccole e centrate sul carattere già scelto per
     ogni profilo (lento/pochi segnali per il conservativo, veloce/molti
     segnali per l'aggressivo) — non una ricerca libera su tutto lo spazio
     possibile, per restare un confronto onesto e non un pretesto per
     scovare per forza una combinazione fortunata. */
  function gridForProfile(name) {
    const grids = {
      conservativo: { fastSet: [40, 60], slowSet: [150, 200], trendSet: [0.6, 0.9], trailSet: [8, 12] },
      moderato:     { fastSet: [15, 25], slowSet: [40, 60],  trendSet: [0.3, 0.6], trailSet: [12, 18] },
      aggressivo:   { fastSet: [6, 12],  slowSet: [18, 27],  trendSet: [0.2, 0.4], trailSet: [15, 25] }
    };
    return grids[name];
  }

  function combinedReturn(profile, slices) {
    const curves = profile.symbols.map((sym, i) => slices[i]);
    const combined = curves.length > 1 ? combineCurves(curves) : curves[0];
    let peak = combined[0], maxDD = 0;
    for (const v of combined) { if (v > peak) peak = v; const d = (v - peak) / peak; if (d < maxDD) maxDD = d; }
    return { total: combined[combined.length - 1] / combined[0] - 1, maxDD };
  }

  async function runWalkForward(name, testDays = 30) {
    const profile = BOT_PROFILES[name];
    if (!profile) throw new Error('profilo sconosciuto: ' + name);
    const grid = gridForProfile(name);

    const perSymbol = {};
    for (const sym of profile.symbols) perSymbol[sym] = await klines(sym, '1d', 2000);
    const n = Math.min(...profile.symbols.map(s => perSymbol[s].length));

    const windows = [];
    let start = WALK_TRAIN_DAYS;
    while (start + testDays <= n) {
      // 1. SCELTA — solo sui 365 giorni precedenti a "start"
      const trainSlices = profile.symbols.map(sym => perSymbol[sym].slice(start - WALK_TRAIN_DAYS, start));
      let best = null;
      for (const fast of grid.fastSet) for (const slow of grid.slowSet) {
        if (fast >= slow) continue;
        for (const trendMinATR of grid.trendSet) for (const trailPct of grid.trailSet) {
          const results = trainSlices.map(sl => backtestTrend(sl, fast, slow, trendMinATR, trailPct, profile.feePct));
          const { total } = combinedReturn(profile, results.map(r => r.curve));
          const tradeCount = results.reduce((a, r) => a + r.trades, 0);
          // a parità di rendimento in allenamento, preferisce la combinazione
          // che ha effettivamente operato — evita di scegliere alla cieca
          // la prima della griglia quando tutte restano ferme a 0%.
          const better = !best || total > best.trainReturn ||
            (total === best.trainReturn && tradeCount > best.tradeCount);
          if (better) best = { fast, slow, trendMinATR, trailPct, trainReturn: total, tradeCount };
        }
      }
      // 2. GIUDIZIO — parametri congelati, applicati al periodo successivo mai visto
      const testSlices = profile.symbols.map(sym => perSymbol[sym].slice(start - 1, start + testDays));
      const testResults = testSlices.map(sl => backtestTrend(sl, best.fast, best.slow, best.trendMinATR, best.trailPct, profile.feePct));
      const { total: testReturn, maxDD } = combinedReturn(profile, testResults.map(r => r.curve));
      const annReturn = Math.pow(1 + testReturn, 365 / testDays) - 1;
      const flat = testResults.every(r => r.trades === 0);

      windows.push({ params: best, testReturn, annReturn, maxDD, flat });
      start += testDays;
    }

    const rets = windows.map(w => w.annReturn);
    const dd = windows.map(w => w.maxDD);
    const stats = summarize(rets, dd);
    const flatShare = windows.filter(w => w.flat).length / windows.length * 100;
    const first = perSymbol[profile.symbols[0]][0];
    const last = perSymbol[profile.symbols[0]][perSymbol[profile.symbols[0]].length - 1];
    return {
      profile: name, testDays, trainDays: WALK_TRAIN_DAYS, windows: windows.length,
      meanReturn: stats.mean * 100, medianReturn: stats.median * 100,
      winRate: stats.winRate * 100, avgDrawdown: stats.avgDD * 100,
      probBigDrawdown: stats.probBig * 100, flatShare,
      fromDays: Math.round((last.time - first.time) / 86400)
    };
  }

  global.RafoxMarket = {
    ASSETS, bySym, fmt,
    on, start, setKline, reconnect,
    klines, ticker24h, ema, loadChartLib,
    backtest: { profiles: BOT_PROFILES, run: runProfileBacktest, runWalkForward },
    price: s => prices[s],
    daily: s => daily[s] || {},
    prices: () => Object.assign({}, prices)
  };
})(window);
