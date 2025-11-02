 // server.js
// Run: node server.js
// Env (optional): PORT=10000 SYMBOLS=ALICEUSDT,LUMIAUSDT POLL_SECONDS=900

const express = require("express");
const axios = require("axios");
const cors = require("cors");

// ----------------- CONFIG -----------------
const PORT = process.env.PORT || 10000;
const SYMBOLS = (process.env.SYMBOLS || "ALICEUSDT,LUMIAUSDT")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 900); // default 15 min

// thresholds you can tune
const PRICE_MOVE_15M_PCT = 3.0;
const OI_MOVE_4H_PCT     = 5.0;
const FUNDING_CROWD_LONG = 0.0005;
const FUNDING_CROWD_SHORT= -0.0005;

// ----------------- HTTP CLIENTS -----------------
const sapi = axios.create({ baseURL: "https://api.binance.com",  timeout: 10000 }); // Spot + Margin
const fapi = axios.create({ baseURL: "https://fapi.binance.com", timeout: 10000 }); // USDⓈ-M Futures
const dapi = axios.create({ baseURL: "https://dapi.binance.com", timeout: 10000 }); // COIN-M Futures

// ----------------- STATE (RAM) -----------------
const store = new Map(); // symbol -> { snapshot, history[] }

// keep ~24h of snapshots in RAM
function keepHistory(sym, snap, maxMs = 24*60*60*1000) {
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

// ----------------- UTIL -----------------
function pct(a, b) {
  if (a == null || b == null || a === 0) return null;
  return ((b - a) / a) * 100.0;
}
function lastClose(kl) { if (!kl?.length) return null; return Number(kl.at(-1)[4]); }
function closeAtOrBefore(kl, msAgo) {
  if (!kl?.length) return null;
  const target = Date.now() - msAgo;
  let candidate = kl[0];
  for (const k of kl) {
    if (k[6] <= target) candidate = k; else break;
  }
  return Number(candidate[4]);
}
function logErr(symbol, where, err) {
  console.error(`[${symbol}] ${where} error`, err.response?.status, err.response?.data || err.message);
}

// ----------------- MARKET DETECTION -----------------
// caches
const spotListed = new Map();     // symbol -> boolean
const usdMListed = new Map();     // symbol -> boolean (USDT-M)
const coinMPerp  = new Map();     // baseAsset -> "BASEUSD_PERP" (COIN-M)

async function detectMarkets(symbol) {
  // Spot?
  if (!spotListed.has(symbol)) {
    try { await sapi.get("/api/v3/exchangeInfo", { params: { symbol } });
      spotListed.set(symbol, true);
    } catch { spotListed.set(symbol, false); }
  }
  // USDⓈ-M?
  if (!usdMListed.has(symbol)) {
    try { await fapi.get("/fapi/v1/exchangeInfo", { params: { symbol } });
      usdMListed.set(symbol, true);
    } catch { usdMListed.set(symbol, false); }
  }
  // COIN-M (scan once)
  if (!coinMPerp.size) {
    try {
      const { data } = await dapi.get("/dapi/v1/exchangeInfo");
      for (const s of data.symbols || []) {
        if (s.contractType === "PERPETUAL") {
          // s.symbol like "ALICEUSD_PERP", s.baseAsset like "ALICE"
          coinMPerp.set(s.baseAsset, s.symbol);
        }
      }
    } catch (err) {
      console.warn("coinM exchangeInfo scan failed:", err.message);
    }
  }
  const base = symbol.replace(/USDT$/,''); // e.g., ALICEUSDT -> ALICE
  return {
    spot: spotListed.get(symbol) || false,
    usdM: usdMListed.get(symbol) || false,
    coinM: coinMPerp.get(base) || null
  };
}

// ----------------- FETCHERS -----------------
async function fetchSpot24h(symbol) {
  try {
    const { data } = await sapi.get("/api/v3/ticker/24hr", { params: { symbol } });
    return {
      price: Number(data.lastPrice ?? NaN),
      volume: Number(data.volume ?? 0),                 // BASE
      takerBuyBase: Number(data.takerBuyBaseAssetVolume ?? 0),
      quoteVolume: Number(data.quoteVolume ?? 0)
    };
  } catch (e) { logErr(symbol, "spot24h", e); return null; }
}
async function fetchKlines(symbol, interval, limit) {
  try {
    const { data } = await sapi.get("/api/v3/klines", { params: { symbol, interval, limit } });
    return data;
  } catch (e) { logErr(symbol, `klines ${interval}`, e); return null; }
}

// USDⓈ-M (fapi)
async function fapiPremiumIndex(symbol) {
  try { const { data } = await fapi.get("/fapi/v1/premiumIndex", { params: { symbol } }); return data; }
  catch (e) { logErr(symbol, "fapi premiumIndex", e); return null; }
}
async function fapiFundingHist(symbol, limit=20) {
  try {
    const { data } = await fapi.get("/fapi/v1/fundingRate", { params: { symbol, limit } });
    return data.map(x => ({ rate: Number(x.fundingRate), time: Number(x.fundingTime) }));
  } catch (e) { logErr(symbol, "fapi fundingHist", e); return []; }
}
async function fapiOpenInterest(symbol) {
  try { const { data } = await fapi.get("/fapi/v1/openInterest", { params: { symbol } });
    return Number(data.openInterest ?? 0);
  } catch (e) { logErr(symbol, "fapi openInterest", e); return null; }
}
async function fapiOpenInterestHist(symbol, period="4h", limit=30) {
  try {
    const { data } = await fapi.get("/fapi/v1/openInterestHist", { params: { symbol, period, limit } });
    return data.map(x => ({ oi: Number(x.sumOpenInterest), time: Number(x.timestamp) }));
  } catch (e) { logErr(symbol, "fapi oiHist", e); return []; }
}
async function fapiLiquidations(symbol, limit=40) {
  try {
    const { data } = await fapi.get("/fapi/v1/allForceOrders", { params: { symbol, limit } });
    return data.map(x => ({ side: x.side, price: Number(x.price), qty: Number(x.origQty), time: Number(x.updateTime) }));
  } catch (e) { logErr(symbol, "fapi liquidations", e); return []; }
}

// COIN-M (dapi) uses *_USD_PERP style symbols
async function dapiPremiumIndex(symbolCoinM) {
  try { const { data } = await dapi.get("/dapi/v1/premiumIndex", { params: { symbol: symbolCoinM } }); return data; }
  catch (e) { console.error("dapi premiumIndex", e.response?.status, e.response?.data || e.message); return null; }
}
async function dapiFundingHist(symbolCoinM, limit=20) {
  try {
    const { data } = await dapi.get("/dapi/v1/fundingRate", { params: { symbol: symbolCoinM, limit } });
    return data.map(x => ({ rate: Number(x.fundingRate), time: Number(x.fundingTime) }));
  } catch (e) { console.error("dapi fundingHist", e.response?.status, e.response?.data || e.message); return []; }
}
async function dapiLiquidations(symbolCoinM, limit=40) {
  try {
    const { data } = await dapi.get("/dapi/v1/allForceOrders", { params: { symbol: symbolCoinM, limit } });
    return data.map(x => ({ side: x.side, price: Number(x.price), qty: Number(x.origQty), time: Number(x.updateTime) }));
  } catch (e) { console.error("dapi liquidations", e.response?.status, e.response?.data || e.message); return []; }
}

// ----------------- SIGNAL ENGINE -----------------
function makeSignal(s) {
  // s: { priceNow, price15mAgo, fundingNow, fundingPrev, oiNow, oi4hAgo, netFlowBase }
  const reasons = [];
  let score = 0;

  const dp15 = pct(s.price15mAgo, s.priceNow);
  const doi4h = pct(s.oi4hAgo, s.oiNow);

  if (dp15 != null) {
    if (dp15 >= PRICE_MOVE_15M_PCT) { score += 2; reasons.push(`Price +${dp15.toFixed(2)}% (15m)`); }
    else if (dp15 <= -PRICE_MOVE_15M_PCT) { score -= 2; reasons.push(`Price ${dp15.toFixed(2)}% (15m)`); }
  }
  if (doi4h != null) {
    if (doi4h >= OI_MOVE_4H_PCT) {
      score += (dp15 && dp15 > 0) ? 2 : 1; reasons.push(`OI +${doi4h.toFixed(2)}% (4h)`);
    } else if (doi4h <= -OI_MOVE_4H_PCT) {
      if (dp15 && dp15 > 0) score += 1; reasons.push(`OI ${doi4h.toFixed(2)}% (4h)`);
    }
  }
  if (s.fundingPrev != null && s.fundingNow != null && Math.sign(s.fundingPrev) !== Math.sign(s.fundingNow)) {
    score += 1; reasons.push("Funding flip");
  }
  if (s.fundingNow != null) {
    if (s.fundingNow > FUNDING_CROWD_LONG * 3) { score -= 1; reasons.push("Crowded longs"); }
    if (s.fundingNow < FUNDING_CROWD_SHORT * 3) { score += 1; reasons.push("Crowded shorts"); }
  }
  if (s.netFlowBase != null) {
    reasons.push(s.netFlowBase >= 0
      ? `Money flow: +${s.netFlowBase.toFixed(0)} (taker-buys > sells)`
      : `Money flow: ${s.netFlowBase.toFixed(0)} (taker-sells > buys)`);
  }

  const signal = score >= 3 ? "BUY" : score <= -2 ? "SELL" : "NEUTRAL";
  return { signal, score, reasons, dp15, doi4h };
}

// ----------------- SNAPSHOT BUILDER -----------------
async function buildSnapshot(symbol) {
  try {
    const { spot, usdM, coinM } = await detectMarkets(symbol); // coinM like "ALICEUSD_PERP" or null

    // ---- Spot (safe only if listed) ----
    let spot24=null, kl15=null, kl4h=null;
    if (spot) {
      [spot24, kl15, kl4h] = await Promise.all([
        fetchSpot24h(symbol),
        fetchKlines(symbol, "15m", 30),
        fetchKlines(symbol, "4h", 30)
      ]);
    }

    // ---- USDⓈ-M Futures ----
    let fundingNow=null, nextFundingTime=null, markPrice=null, fundHist=[], oiNow=null, oiHist=[], liqs=[];
    if (usdM) {
      const pi = await fapiPremiumIndex(symbol);
      if (pi) {
        fundingNow = Number(pi.lastFundingRate ?? 0);
        nextFundingTime = pi.nextFundingTime ?? null;
        markPrice = Number(pi.markPrice ?? 0);
      }
      fundHist = await fapiFundingHist(symbol, 20);
      oiNow    = await fapiOpenInterest(symbol);
      oiHist   = await fapiOpenInterestHist(symbol, "4h", 30);
      liqs     = await fapiLiquidations(symbol, 40);
    }

    // ---- COIN-M Futures (only if not usdM but coinM exists) ----
    if (!usdM && coinM) {
      const pi = await dapiPremiumIndex(coinM);
      if (pi) {
        fundingNow = Number(pi.lastFundingRate ?? 0);
        nextFundingTime = pi.nextFundingTime ?? null;
        markPrice = Number(pi.markPrice ?? 0);
      }
      fundHist = await dapiFundingHist(coinM, 20);
      // OI (coin-M) optional; skip or add later
      liqs     = await dapiLiquidations(coinM, 40);
    }

    // ---- Derive safely ----
    const priceNow     = kl15 ? lastClose(kl15) : (spot24?.price ?? markPrice ?? null);
    const price15mAgo  = kl15 ? closeAtOrBefore(kl15, 15*60*1000) : null;
    const price4hAgo   = kl4h ? closeAtOrBefore(kl4h, 4*60*60*1000) : null;

    let netFlowBase = null; // taker-buy vs taker-sell proxy (spot 24h)
    if (spot24) {
      const sellsBase = Math.max(spot24.volume - spot24.takerBuyBase, 0);
      netFlowBase = spot24.takerBuyBase - sellsBase; // >0 buy-dominant
    }

    const derived = {
      priceNow, price15mAgo, price4hAgo,
      fundingNow,
      fundingPrev: fundHist.length >= 2 ? fundHist.at(-2).rate : null,
      oiNow,
      oi4hAgo: oiHist.length >= 2 ? oiHist.at(-2).oi : null,
      netFlowBase
    };
    const sig = makeSignal(derived);

    const snap = {
      symbol,
      price: priceNow,
      fundingRate: fundingNow,
      nextFundingTime,
      openInterest: oiNow,
      markPrice,
      spot24: spot24 ? {
        volume: spot24.volume,
        takerBuyBase: spot24.takerBuyBase,
        quoteVolume: spot24.quoteVolume
      } : null,
      deltas: {
        price15mPct: sig.dp15,
        oi4hPct: sig.doi4h,
        netFlowBase
      },
      fundingHist: fundHist.slice(-6),
      oiHist: oiHist.slice(-6),
      liquidations: liqs.slice(-10),
      signal: { value: sig.signal, score: sig.score, reasons: sig.reasons },
      markets: { spot, usdM, coinM: !!coinM },
      fetchedAt: Date.now()
    };

    keepHistory(symbol, snap);
    return snap;
  } catch (err) {
    logErr(symbol, "buildSnapshot", err);
    return { symbol, error: err.response?.status || err.message, fetchedAt: Date.now() };
  }
}

// ----------------- POLLER -----------------
async function pollAll() {
  const out = [];
  for (const s of SYMBOLS) out.push(await buildSnapshot(s));
  return out;
}
(async function bootstrap() {
  await pollAll();
  setInterval(pollAll, POLL_SECONDS * 1000);
})();

// ----------------- API -----------------
const app = express();
app.use(cors());

app.get("/", (_req, res) => res.send("✅ Crypto Metrics collector is live"));

app.get("/api/now", async (req, res) => {
  const symbols = (req.query.symbols ? String(req.query.symbols) : SYMBOLS.join(","))
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

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

app.listen(PORT, () => {
  console.log(`Listening on :${PORT} | symbols=${SYMBOLS.join(",")} | poll=${POLL_SECONDS}s`);
});
