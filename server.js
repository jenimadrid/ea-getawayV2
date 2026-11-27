'use strict';
// EA Bot gateway for Binance Spot. Node 18+, no dependencies.
// Holds your API keys, runs the strategy, places orders, and serves the phone dashboard.

const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const E = process.env;
const LIVE = E.LIVE === 'true';                       // anything else = testnet (practice)
const BASE = LIVE ? 'https://api.binance.com' : 'https://testnet.binance.vision';
const KEY = E.BINANCE_KEY, SECRET = E.BINANCE_SECRET, TOKEN = E.GATEWAY_TOKEN;
const PORT = +E.PORT || 3000;

if (!KEY || !SECRET || !TOKEN || TOKEN.length < 16) {
  console.error('Set BINANCE_KEY, BINANCE_SECRET and GATEWAY_TOKEN (at least 16 characters).');
  process.exit(1);
}

// ---------- state (saved to state.json so open trades survive a restart) ----------
const FILE = path.join(__dirname, 'state.json');
const S = {
  cfg: { symbols: ['BTCUSDT', 'ETHUSDT'], interval: '5m', riskPct: 1, slPct: 1, tpPct: 2,
         maxOpen: 2, maxNotionalPct: 20, dailyLossPct: 3, startHour: 8, endHour: 19 },
  running: false, pos: [], dayKey: '', dayStartBal: null, dayPnl: 0, last: {}, log: []
};
try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); Object.assign(S, d, { cfg: { ...S.cfg, ...d.cfg } }); } catch {}
S.running = false;                                    // never auto-start after a restart
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(S)); } catch {} };
const log = m => { S.log.unshift(new Date().toLocaleTimeString() + '  ' + m); S.log = S.log.slice(0, 40); console.log(m); };

// ---------- Binance REST ----------
let banUntil = 0;
async function bn(method, p, params = {}, signed = false) {
  if (Date.now() < banUntil) throw new Error('Rate limited, backing off');
  const q = new URLSearchParams(params);
  if (signed) {
    q.set('timestamp', Date.now()); q.set('recvWindow', 5000);
    q.set('signature', crypto.createHmac('sha256', SECRET).update(q.toString()).digest('hex'));
  }
  const r = await fetch(BASE + p + '?' + q, { method, headers: { 'X-MBX-APIKEY': KEY } });
  if (r.status === 429 || r.status === 418) {
    banUntil = Date.now() + (+r.headers.get('retry-after') || 60) * 1000;
    throw new Error('Binance rate limit (' + r.status + ')');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status >= 500) { const e = new Error('Binance server error ' + r.status + ' (result unknown)'); e.unknown = true; throw e; }
  if (!r.ok) throw new Error('Binance ' + r.status + ': ' + (j.msg || ''));
  return j;
}

const filt = {};
async function filters(sym) {
  if (!filt[sym]) {
    const i = (await bn('GET', '/api/v3/exchangeInfo', { symbol: sym })).symbols[0];
    const f = Object.fromEntries(i.filters.map(x => [x.filterType, x]));
    filt[sym] = { base: i.baseAsset, step: +f.LOT_SIZE.stepSize,
                  minNotional: +((f.NOTIONAL || f.MIN_NOTIONAL || {}).minNotional || 0) };
  }
  return filt[sym];
}
const floorStep = (q, step) => (Math.floor(q / step + 1e-9) * step).toFixed(Math.max(0, Math.round(-Math.log10(step))));
const freeUSDT = async () => +((await bn('GET', '/api/v3/account', {}, true)).balances.find(b => b.asset === 'USDT') || { free: 0 }).free;

// ---------- strategy: EMA 9/21 cross (long only, spot) ----------
const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; };
async function signal(sym) {
  const k = await bn('GET', '/api/v3/klines', { symbol: sym, interval: S.cfg.interval, limit: 80 });
  const closed = k.slice(0, -1), t = closed[closed.length - 1][0];
  if (S.last[sym] === t) return null;                 // already checked this candle
  S.last[sym] = t;
  const c = closed.map(x => +x[4]), v = closed.map(x => +x[5]);
  const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  if (v[v.length - 1] < avg * 0.5) return null;       // volume too low, skip
  const p = c.slice(0, -1);
  return ema(p, 9) <= ema(p, 21) && ema(c, 9) > ema(c, 21) ? 'buy' : null;
}

// ---------- orders ----------
async function openPos(sym) {
  const f = await filters(sym), bal = await freeUSDT(), c = S.cfg;
  const notional = Math.min((bal * c.riskPct / 100) / (c.slPct / 100), bal * c.maxNotionalPct / 100);
  if (notional < Math.max(f.minNotional, 1)) { log(sym + ': size too small (' + notional.toFixed(2) + ' USDT), skipped'); return; }
  const cid = 'ea' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let o;
  try {
    o = await bn('POST', '/api/v3/order', { symbol: sym, side: 'BUY', type: 'MARKET', quoteOrderQty: notional.toFixed(2),
                                            newClientOrderId: cid, newOrderRespType: 'FULL' }, true);
  } catch (e) {
    if (!e.unknown) throw e;
    try { o = await bn('GET', '/api/v3/order', { symbol: sym, origClientOrderId: cid }, true); } catch {}
    if (!o || o.status !== 'FILLED') {
      S.running = false; log('Order status unknown for ' + sym + '. Bot stopped. Check Binance manually.'); return;
    }
  }
  let qty = +o.executedQty;
  (o.fills || []).forEach(x => { if (x.commissionAsset === f.base) qty -= +x.commission; });
  const cost = +o.cummulativeQuoteQty, entry = cost / +o.executedQty;
  S.pos.push({ sym, qty, cost, entry, px: entry, sl: entry * (1 - c.slPct / 100), tp: entry * (1 + c.tpPct / 100) });
  log('BUY ' + sym + ' ' + cost.toFixed(2) + ' USDT @ ' + entry);
}

async function closePos(p, why) {
  const f = await filters(p.sym);
  const o = await bn('POST', '/api/v3/order', { symbol: p.sym, side: 'SELL', type: 'MARKET',
                                                quantity: floorStep(p.qty, f.step), newOrderRespType: 'FULL' }, true);
  let fee = 0; (o.fills || []).forEach(x => { if (x.commissionAsset === 'USDT') fee += +x.commission; });
  const pnl = +o.cummulativeQuoteQty - fee - p.cost;
  S.dayPnl += pnl; S.pos = S.pos.filter(x => x !== p);
  log('SELL ' + p.sym + ' (' + why + ') ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' USDT');
}

// ---------- main loop ----------
async function entries() {
  const h = new Date().getHours(), c = S.cfg;         // server time; set TZ env for your timezone
  if (h < c.startHour || h >= c.endHour) return;
  if (S.dayStartBal == null) S.dayStartBal = await freeUSDT();
  if (S.dayPnl <= -S.dayStartBal * c.dailyLossPct / 100) { S.running = false; log('Daily loss limit reached. Bot stopped.'); return; }
  for (const sym of c.symbols) {
    if (!S.running || S.pos.length >= c.maxOpen) break;
    if (S.pos.some(p => p.sym === sym)) continue;
    if (await signal(sym) === 'buy') await openPos(sym);
  }
}
async function loop() {
  try {
    const day = new Date().toDateString();
    if (S.dayKey !== day) { S.dayKey = day; S.dayPnl = 0; S.dayStartBal = null; }
    if (S.pos.length) {                               // exits are always watched, even when the bot is paused
      const syms = [...new Set(S.pos.map(p => p.sym))];
      const px = Object.fromEntries((await bn('GET', '/api/v3/ticker/price', { symbols: JSON.stringify(syms) })).map(x => [x.symbol, +x.price]));
      for (const p of [...S.pos]) {
        p.px = px[p.sym];
        if (p.px <= p.sl) await closePos(p, 'stop loss'); else if (p.px >= p.tp) await closePos(p, 'take profit');
      }
    }
    if (S.running) await entries();
  } catch (e) { log('Error: ' + e.message); }
  save(); setTimeout(loop, 5000);
}

// ---------- HTTP API + dashboard ----------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const authed = t => { const a = Buffer.from(t || ''), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 5000) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d)); } catch { r({}); } }); });
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (!authed((req.headers.authorization || '').replace('Bearer ', ''))) {
    await new Promise(r => setTimeout(r, 1000)); return send(res, 401, { error: 'Wrong token' });
  }
  try {
    if (p === '/api/status') return send(res, 200, { mode: LIVE ? 'LIVE' : 'TESTNET', running: S.running, cfg: S.cfg, pos: S.pos, dayPnl: S.dayPnl, log: S.log.slice(0, 15) });
    if (req.method !== 'POST') return send(res, 404, {});
    if (p === '/api/start') { S.running = true; log('Bot started'); }
    else if (p === '/api/stop') { S.running = false; log('Bot paused'); }
    else if (p === '/api/closeall') { S.running = false; for (const x of [...S.pos]) await closePos(x, 'manual'); log('Closed all and stopped'); }
    else if (p === '/api/config') {
      const b = await body(req), c = S.cfg;
      if (Array.isArray(b.symbols)) c.symbols = b.symbols.filter(s => /^[A-Z0-9]{5,12}$/.test(s)).slice(0, 40);
      if (['1m', '5m'].includes(b.interval)) c.interval = b.interval;
      c.riskPct = num(b.riskPct, 0.1, 5, c.riskPct); c.slPct = num(b.slPct, 0.1, 10, c.slPct); c.tpPct = num(b.tpPct, 0.1, 20, c.tpPct);
      c.maxOpen = num(b.maxOpen, 1, 10, c.maxOpen); c.maxNotionalPct = num(b.maxNotionalPct, 1, 50, c.maxNotionalPct);
      c.dailyLossPct = num(b.dailyLossPct, 0.5, 20, c.dailyLossPct);
      c.startHour = num(b.startHour, 0, 23, c.startHour); c.endHour = num(b.endHour, 1, 24, c.endHour);
      log('Settings saved');
    } else return send(res, 404, {});
    save(); send(res, 200, { ok: true });
  } catch (e) { log('Error: ' + e.message); send(res, 500, { error: e.message }); }
}).listen(PORT, () => {
  console.log('Gateway on port ' + PORT + ' | mode: ' + (LIVE ? 'LIVE (real money)' : 'TESTNET (practice)'));
  freeUSDT().then(b => log('Connected. Free USDT: ' + b)).catch(e => log('Could not read account: ' + e.message));
  loop();
});
