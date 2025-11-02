// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEFAULT_SYMBOLS = (process.env.SYMBOLS || '').split(',').filter(Boolean);

// --- Binance REST endpoints (USDT-M Futures) ---
const FAPI = 'https://fapi.binance.com'; // futures API (USDT-M)

// helpers
const toArr = (v) =>
  Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : [];

async function fetchSymbolSnapshot(symbol) {
  // price (use futures ticker price to match funding/OI venue)
  const priceReq = axios.get(`${FAPI}/fapi/v1/ticker/price`, { params: { symbol } });

  // funding rate + next funding time (premium index endpoint includes lastFundingRate)
  const fundingReq = axios.get(`${FAPI}/fapi/v1/premiumIndex`, { params: { symbol } });

  // current open interest
  const oiReq = axios.get(`${FAPI}/fapi/v1/openInterest`, { params: { symbol } });

  const [priceRes, fundingRes, oiRes] = await Promise.allSettled([priceReq, fundingReq, oiReq]);

  const price = priceRes.status === 'fulfilled' ? Number(priceRes.value.data.price) : null;

  const fundingData = fundingRes.status === 'fulfilled' ? fundingRes.value.data : {};
  const lastFundingRate = fundingData.lastFundingRate ? Number(fundingData.lastFundingRate) : null;
  const nextFundingTime = fundingData.nextFundingTime ? Number(fundingData.nextFundingTime) : null;

  const oi = oiRes.status === 'fulfilled' ? Number(oiRes.value.data.openInterest) : null;

  return {
    symbol,
    price,
    fundingRate: lastFundingRate,      // e.g. 0.0001 = 0.01% per 8h
    nextFundingTime,                   // ms epoch
    openInterest: oi,                  // in base asset units
    fetchedAt: Date.now()
  };
}

// GET /api/now?symbols=ALICEUSDT,LUMIAUSDT
app.get('/api/now', async (req, res) => {
  const symbols = toArr(req.query.symbols) || DEFAULT_SYMBOLS;
  if (!symbols.length) return res.status(400).json({ error: 'Provide symbols in query or via .env SYMBOLS' });

  try {
    const snaps = await Promise.all(symbols.map(fetchSymbolSnapshot));
    res.json({ data: snaps });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Fetch error' });
  }
});

// Simple rule engine: alerts when funding flips sign or OI moves > X% since last check
const lastState = new Map();  // symbol -> { fundingRate, openInterest }
const OI_PCT_THRESHOLD = 5;   // 5% change trigger

app.get('/api/check', async (req, res) => {
  const symbols = toArr(req.query.symbols) || DEFAULT_SYMBOLS;
  const out = [];

  for (const s of symbols) {
    const snap = await fetchSymbolSnapshot(s);

    const prev = lastState.get(s);
    const alerts = [];

    // funding flip
    if (prev && prev.fundingRate != null && snap.fundingRate != null) {
      if (Math.sign(prev.fundingRate) !== Math.sign(snap.fundingRate)) {
        alerts.push(`Funding flipped sign on ${s}: ${prev.fundingRate} -> ${snap.fundingRate}`);
      }
    }

    // OI % move
    if (prev && prev.openInterest && snap.openInterest) {
      const pct = ((snap.openInterest - prev.openInterest) / prev.openInterest) * 100;
      if (Math.abs(pct) >= OI_PCT_THRESHOLD) {
        alerts.push(`Open interest moved ${pct.toFixed(2)}% on ${s}`);
      }
    }

    lastState.set(s, { fundingRate: snap.fundingRate, openInterest: snap.openInterest });
    out.push({ snapshot: snap, alerts });
  }

  res.json({ data: out, checkedAt: Date.now() });
});

app.listen(PORT, () => {
  console.log(`Crypto metrics server listening on http://localhost:${PORT}`);
});
