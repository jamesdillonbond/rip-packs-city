// ingest-panini-runner.mjs — Panini Plane-A residential runner (DRAFT / not wired).
//
// Runs on a RESIDENTIAL machine with a Chrome profile already logged into
// nft.paniniamerica.net. It drives that logged-in session with Playwright, lets the
// SITE sign every /onepanini request natively (so RPC never reproduces the 15-minute
// signature or holds the raw token), intercepts the responses, and POSTs normalized
// batches to RPC's panini-ingest route. Same shape as scripts/ingest-allday-badges.mjs.
//
// Go-live: move to scripts/, `npm i -D playwright`, set the env below, schedule it
// (e.g. every few hours) on the residential box.
//
//   PANINI_USER_DATA_DIR   path to a Chrome user-data dir already logged into Panini
//   RPC_PANINI_INGEST_URL  https://www.rippackscity.com/api/cron/panini-ingest
//   INGEST_SECRET_TOKEN    RPC ingest bearer (lives only on this box)
//   PANINI_PSKU_FILE       (optional) newline list of edition pskus to walk; else uses
//                          the enumeration captured from the grid query (see TODO).

import { chromium } from "playwright";
import fs from "node:fs";

const USER_DATA_DIR = process.env.PANINI_USER_DATA_DIR;
const INGEST_URL = process.env.RPC_PANINI_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN;
const BASE = "https://nft.paniniamerica.net";

// Pack pages: /marketplace-details/subpack-<x>-<pack_id>.html  (Hobby pack_id 1038 confirmed).
const PACK_URLS = [
  `${BASE}/marketplace-details/subpack-5242848-1038.html`, // Hobby — confirmed
  // TODO(go-live): + the FOTL pack page (its pack_id), + any craft/challenge packs.
];

// Edition pages: /marketplace-details/<psku>.html
// TODO(go-live): populate the full psku list from the grid-enumeration capture
// (getMarketPlaceList-style call on /marketplace/nfts.html). One per (player × parallel).
function loadPskus() {
  if (process.env.PANINI_PSKU_FILE && fs.existsSync(process.env.PANINI_PSKU_FILE)) {
    return fs.readFileSync(process.env.PANINI_PSKU_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return ["packcard-2332_486964_12579093_31"]; // sample (Désiré Doué Maple Leaf /9)
}

const BATCH = 60;

async function post(payload) {
  const n = (payload.cards?.length || 0) + (payload.packs?.length || 0) + (payload.serials?.length || 0);
  if (!n) return;
  const r = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_TOKEN}` },
    body: JSON.stringify(payload),
  });
  console.log(`[panini-runner] posted cards=${payload.cards?.length||0} packs=${payload.packs?.length||0} serials=${payload.serials?.length||0} -> ${r.status}`);
}

async function main() {
  if (!USER_DATA_DIR || !INGEST_URL || !INGEST_TOKEN) throw new Error("missing env (PANINI_USER_DATA_DIR / RPC_PANINI_INGEST_URL / INGEST_SECRET_TOKEN)");
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: true });
  const page = await ctx.newPage();

  let cards = [], packs = [], serials = [];
  // Native response interception — no in-page hook, no signing, no token handling here.
  page.on("response", async (resp) => {
    if (!resp.url().includes("/onepanini") || resp.status() !== 200) return;
    let j; try { j = await resp.json(); } catch { return; }
    const d = j?.data; if (!d) return;
    if (d.getCardMarketStats?.data) cards.push(d.getCardMarketStats.data);
    if (d.getPackMarketStats?.data) packs.push(d.getPackMarketStats.data);
    const prods = d.getPskuTotalCardsList?.data?.products;
    if (Array.isArray(prods)) serials.push(...prods);
  });

  for (const url of PACK_URLS) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(900);
  }
  for (const psku of loadPskus()) {
    await page.goto(`${BASE}/marketplace-details/${psku}.html`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(900);
    if (cards.length + serials.length >= BATCH) { await post({ cards, serials }); cards = []; serials = []; }
  }
  await post({ cards, packs, serials });
  await ctx.close();
}

main().catch((e) => { console.error("[panini-runner] fatal:", e); process.exit(1); });
