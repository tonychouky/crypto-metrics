  // server.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 10000;
const DEFAULT_SYMBOLS = (process.env.SYMBOLS || "ALICEUSDT,LUMIAUSDT")
  .split(",")
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

// Helpers — Binance Futures endpoints
const fapi = axios.create({
  baseURL: "https://fapi.binance.com",
  timeout: 8000,
});

// Fetch one symbol (price, funding, OI)
async function fetchSymbol(symbol) {
  try {
    // price
    const [priceRes, fundingRes, oiRes] = await Promise.all([
      fapi.get("/fapi/v1/ticker/price", { params: { symbol } }),
      // premiumIndex returns current funding rate + nextFundingTime
      fapi.get("/fapi/v1/premiumIndex", { params: { symbol } }),
      fapi.get("/fapi/v1/openInterest", { params: { symbol } }),
    ]);

    const price = Number(priceRes.data?.price ?? null);
    const fundingRate = Number(fundingRes.data?.lastFundingRate ?? null);
    const nextFundingTime = fundingRes.data?.nextFundingTime ?? null;
    const openInterest = Number(oiRes.data?.openInterest ?? null);

    return {
      symbol,
      price: Number.isFinite(price) ? price : null,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : null,
      nextFundingTime,
      openInterest: Number.isFinite(openInterest) ? openInterest : null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.error(`[${symbol}] fetch error:`, err.message);
    return {
      symbol,
      price: null,
      fundingRate: null,
      nextFundingTime: null,
      openInterest: null,
      fetchedAt: Date.now(),
      error: err.message,
    };
  }
}

app.get("/api/now", async (req, res) => {
  const symbols = (req.query.symbols || DEFAULT_SYMBOLS).toString().split(",")
    .map(s => s.trim().toUpperCase()).filter(Boolean);

  const data = await Promise.all(symbols.map(fetchSymbol));
  res.json({ data, checkedAt: Date.now() });
});

app.get("/", (_req, res) => {
  res.send("Crypto metrics server is live ✨");
});

app.listen(PORT, () => {
  console.log(`Crypto metrics server listening on http://localhost:${PORT}`);
});
