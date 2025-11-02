 const express = require("express");
const axios = require("axios");
const cors = require("cors");

// ---------- CONFIG ----------
const PORT = process.env.PORT || 10000;
const SYMBOLS = (process.env.SYMBOLS || "ALICEUSDT,LUMIAUSDT")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 900); // 900 = 15m

// thresholds you can tune
const PRICE_MOVE_15M_PCT = 3.0;
const OI_MOVE_4H_PCT = 5.0;
const FUNDING_CROWDED_LONG = 0.0005;   // 0.05%/8h
const FUNDING_CROWDED_SHORT = -0.0005;

// ---------- BINANCE CLIENTS ----------
const sapi = axios.create({ baseURL: "https://api.binance.com", timeout: 9000 });
const fapi = axios.create({ baseURL: "https://fapi.binance.com", timeout: 9000 });

// ---------- IN-MEMORY DB ----------
const store = new Map(); // symbol -> { snapshot, history: [] }

function keepHistory(sym, snap, maxMs = 24 * 60 * 60 * 1000) { // keep last 24h in RAM
  if (!store.has(sym)) store.set(sym, { snapshot: null, history: [] });
  const o = store.get(sym);
  o.snapshot = snap;
  o.history.push(snap);
  const cutoff = Date.now() - maxMs;
  o.history = o.history.filter(x => x.fetchedAt >= cutoff);
}

function hist(sym) {
  return store.get(sym)?.history || [];
}

// ---------- HELPERS ----------
function pct(a, b) {
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100.0;
}

function lastClose(klines) {
  if (!klines || !klines.length) return null;
  const k = klines[klines.length - 1];
  return Number(k[4]); // close
}

function findCloseAtOrBefore(klines, msAgo) {
  if (!klines || !klines.length) return null;
  const target = Date.now() - msAgo;
  let candidate = klines[0];
  for (const k of klines) {
    if (k[6] <= target) candidate = k; else break;
  }
  return Number(candidate[4]); // close
}

// ---------- FETCHERS (Binance) ----------
async function fetchSpot24h(symbol) {
  const { data } = await sapi.get("/api/v3/ticker/24hr", { params: { symbol } });
  // volumes are BASE units
  return {
    volume: Number(data.volume ?? 0),
    takerBuyBase: Number(data.takerBuyBaseAssetVolume ?? 0),
    quoteVolume: Number(data.quoteVolume ?? 0),
    price: Number(data.lastPrice ?? NaN),
  };
}

async function fetchKlines(symbol, interval, limit) {
  const { data } = await sapi.get("/api/v3/klines", { params: { symbol, interval, limit } });
  return data; // [openTime,open,high,low,close,volume,closeTime,...]
}

async function fetchPremiumIndex(symbol) {
  const { data } = await fapi.get("/fapi/v1/premiumIndex", { params: { symbol } });
  return {
    fundingRate: Number(data.lastFundingRate ?? 0),
    nextFundingTime: data.nextFundingTime ?? null,
    markPrice: Number(data.markPrice ?? 0)
  };
}

async function fetchFundingHist(symbol, limit = 20) {
  const { data } = await fapi.get("/fapi/v1/fundingRate", { params: { symbol, limit } });
  // array of { fundingRate, fundingTime }
  return data.map(x => ({ rate: Number(x.fundingRate), time: Number(x.fundingTime) }));
}

async function fetchOpenInterest(symbol) {
  const { data } = await fapi.get("/fapi/v1/openInterest", { params: { symbol } });
  return Number(data.openInterest ?? 0);
}

async function fetchOpenInterestHist(symbol, period = "4h", limit = 30) {
  const { data } = await fapi.get("/fapi/v1/openInterestHist", { params: { symbol, period, limit } });
  // [{sumOpenInterest, timestamp}]
  return data.map(x => ({ oi: Number(x.sumOpenInterest), time: Number(x.timestamp) }));
}

async function fetchLiquidations(symbol, limit = 50) {
  // recent liquidation orders
  const { data } = await fapi.get("/fapi/v1/allForceOrders", { params: { symbol, limit } });
  return data.map(x => ({
    side: x.side, // BUY means short liquidations (price up), SELL means long liquidations
    price: Number(x.price),
    qty: Number(x.origQty),
    time: Number(x.updateTime)
  }));
}

// ---------- SIGNAL ENGINE ----------
function makeSignal(s) {
  // s has:
  // priceNow, price15mAgo, price4hAgo,
  // fundingNow, fundingPrev,
  // oiNow, oi4hAgo,
  // netFlowBase (takerBuyBase - (volume - takerBuyBase))
  const reasons = [];
  let score = 0;

  const dp15 = pct(s.price15mAgo, s.priceNow);
  const doi4h = pct(s.oi4hAgo, s.oiNow);

  if (dp15 != null) {
    if (dp15 >= PRICE_MOVE_15M_PCT) { score += 2; reasons.push(`Price +${dp15.toFixed(2)}% (15m)`); }
    else if (dp15 <= -PRICE_MOVE_15M_PCT) { score -= 2; reasons.push(`Price ${dp15.toFixed(2)}% (15m)`); }
  }

  if (doi4h != null) {
    if (doi4h >= OI_MOVE_4H_PCT) { score += (dp15 && dp15 > 0) ? 2 : 1; reasons.push(`OI +${doi4h.toFixed(2)}% (4h)`); }
    else if (doi4h <= -OI_MOVE_4H_PCT) { if (dp15 && dp15 > 0) score += 1; reasons.push(`OI ${doi4h.toFixed(2)}% (4h)`); }
  }

  if (s.fundingPrev != null && s.fundingNow != null && Math.sign(s.fundingPrev) !== Math.sign(s.fundingNow)) {
    score += 1; reasons.push("Funding flip");
  }

  if (s.fundingNow != null) {
    if (s.fundingNow > FUNDING_CROWDED_LONG * 3) { score -= 1; reasons.push("Crowded longs"); }
    if (s.fundingNow < FUNDING_CROWDED_SHORT * 3) { score += 1; reasons.push("Crowded shorts"); }
  }

  if (s.netFlowBase != null) {
    if (s.netFlowBase > 0) reasons.push(`Money flow: +${s.netFlowBase.toFixed(0)} (taker-buys>taker-sells)`);
    else if (s.netFlowBase < 0) reasons.push(`Money flow: ${s.netFlowBase.toFixed(0)} (taker-sells>taker-buys)`);
  }

  const signal = (score >= 3) ? "BUY" : (score <= -2) ? "SELL" : "NEUTRAL";
  return { signal, reasons, score, dp15, doi4h };
}

// ---------- POLLER ----------
async function buildSnapshot(symbol) {
  try {
    // spot summary (includes taker-buy volume proxy)
    const spot24 = await fetchSpot24h(symbol);

    // klines for 15m & 4h (to compute 15m/4h price deltas)
    const [kl15, kl4h] = await Promise.all([
      fetchKlines(symbol, "15m", 30),
      fetchKlines(symbol, "4h", 30)
    ]);
    const priceNow = lastClose(kl15);
    const price15mAgo = findCloseAtOrBefore(kl15, 15 * 60 * 1000);
    const price4hAgo = findCloseAtOrBefore(kl4h, 4 * 60 * 60 * 1000);

    // derivatives: funding (now + history) and OI (now + history)
    const [pi, fundHist, oiNow, oiHist, liqs] = await Promise.all([
      fetchPremiumIndex(symbol),
      fetchFundingHist(symbol, 20),
      fetchOpenInterest(symbol),
      fetchOpenInterestHist(symbol, "4h", 30),
      fetchLiquidations(symbol, 40),
    ]);

    const fundingNow = pi.fundingRate;
    const fundingPrev = fundHist.length >= 2 ? fundHist[fundHist.length - 2].rate : null;

    const oi4hAgo = oiHist.length >= 2 ? oiHist[oiHist.length - 2].oi : null;

    // money-flow proxy from spot 24h: takerBuyBase vs total volume
    const sellsBase = Math.max(spot24.volume - spot24.takerBuyBase, 0);
    const netFlowBase = (spot24.takerBuyBase - sellsBase); // >0 buy-dominant, <0 sell-dominant

    const derived = {
      priceNow, price15mAgo, price4hAgo,
      fundingNow, fundingPrev,
      oiNow, oi4hAgo,
      netFlowBase
    };
    const sig = makeSignal(derived);

    const snap = {
      symbol,
      price: priceNow,
      fundingRate: fundingNow,
      nextFundingTime: pi.nextFundingTime,
      openInterest: oiNow,
      markPrice: pi.markPrice,
      // raw bits
      spot24: { volume: spot24.volume, takerBuyBase: spot24.takerBuyBase, quoteVolume: spot24.quoteVolume },
      // small extracts for client
      deltas: {
        price15mPct: sig.dp15,
        oi4hPct: sig.doi4h,
        netFlowBase
      },
      fundingHist: fundHist.slice(-6), // last 6 points
      oiHist: oiHist.slice(-6),
      liquidations: liqs.slice(-10),
      signal: { value: sig.signal, score: sig.score, reasons: sig.reasons },
      fetchedAt: Date.now()
    };
    keepHistory(symbol, snap);
    return snap;
  } catch (err) {
    return {
      symbol,
      error: err.response?.status || err.message,
      fetchedAt: Date.now()
    };
  }
}

async function pollAll() {
  const data = [];
  for (const s of SYMBOLS) {
    data.push(await buildSnapshot(s));
  }
  return data;
}

// kick off polling loop
(async function loop() {
  await pollAll();
  setInterval(pollAll, POLL_SECONDS * 1000);
})();

// ---------- API ----------
const app = express();
app.use(cors());

app.get("/", (_req, res) => res.send("✅ Crypto Metrics collector is live"));

app.get("/api/now", async (req, res) => {
  const symbols = (req.query.symbols ? String(req.query.symbols) : SYMBOLS.join(","))
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  // return latest in-memory snapshot; if missing, fetch on-demand
  const out = [];
  for (const s of symbols) {
    const cur = store.get(s)?.snapshot;
    out.push(cur || await buildSnapshot(s));
  }
  res.json({ data: out, checkedAt: Date.now() });
});

app.get("/api/history", (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  res.json({ symbol, history: hist(symbol), fetchedAt: Date.now() });
});

app.listen(PORT, () => console.log(`Listening on :${PORT} | symbols: ${SYMBOLS.join(",")} | poll=${POLL_SECONDS}s`));
