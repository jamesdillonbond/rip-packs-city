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
// WC2026 Prizm World Cup Soccer packs (both captured live via Chrome 2026-07-16):
const PACK_URLS = [
  `${BASE}/marketplace-details/subpack-5270763-1038.html`, // Hobby  (pack_id 1038) — live: ~9,504 unopened, floor ~$249
  `${BASE}/marketplace-details/subpack-5294230-1039.html`, // FOTL   (pack_id 1039) — captured 07-16
  // Add craft/challenge packs here if RPC decides to cover them.
];

// Edition pages: /marketplace-details/<psku>.html
// psku format (confirmed live 2026-07-16): packcard-<setId>_<playerId>_<cardId>_<parallelId>
// The Soccer grid mixes >=5 products; the WC2026 Prizm setId is CONFIRMED = 2332 (verified live
// 2026-07-16 on Base Prizms Red/Silver + Prizmania cards). SCOPE the harvest to packcard-2332_*.
// Card detail DOM labels map to the API fields: UNCLAIMED=unopened_pack_count(still_in_packs),
// WITH COLLECTORS=with_collectors_count(pulled), BURNED=burned_count, REMAINING SUPPLY=end_seq(mint_cap). Enumeration on the box: this Playwright runner's
// page.on("response") intercepts /onepanini at the NETWORK layer (a page-context fetch/XHR
// override does NOT work — the app closes over fetch before injection; verified 07-16).
// Harvest by (a) intercepting the grid getMarketPlaceList response, or (b) scrolling the
// virtualized grid and collecting packcard-<...> base pskus from the card image URLs.
function loadPskus() {
  if (process.env.PANINI_PSKU_FILE && fs.existsSync(process.env.PANINI_PSKU_FILE)) {
    return fs.readFileSync(process.env.PANINI_PSKU_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }
  return ["packcard-2332_486964_12579093_31"]; // sample (Désiré Doué Maple Leaf /9)
}

// ENUMERATION (verified live 2026-07-16): the grid getMarketPlaceList response is
//   { data: { products: { items: [ {psku, sku, athlete, team, cardset, rarity, end_seq(cap),
//     best_offer, buy_now_price, crypto_sale_count, nft_type, thumbnail, image}, ... ] } } }
// The 30-item page enumerates editions but does NOT carry the pull residual
// (unopened_pack_count) — that is per-card getCardMarketStats only, which is why the runner
// must ALSO walk each psku's detail page. INTERCEPTION: the app reads responses via
// Response.text() then JSON.parse. That only breaks IN-PAGE injection; Playwright's
// page.on("response") + resp.json() reads the body at the CDP/network layer independent of
// the page's JS, so the network capture below works regardless.
// Filter enumeration to WC Prizm with psku.startsWith("packcard-2332_").
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

const WC_PREFIX = "packcard-2332_"; // WC2026 Prizm World Cup Soccer setId (verified live 2026-07-16)

async function main() {
  if (!USER_DATA_DIR || !INGEST_URL || !INGEST_TOKEN) throw new Error("missing env (PANINI_USER_DATA_DIR / RPC_PANINI_INGEST_URL / INGEST_SECRET_TOKEN)");
  // First-ever run: set PANINI_HEADLESS=false to open a visible window and log into Panini once;
  // the persistent profile keeps the session for all later headless runs.
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: process.env.PANINI_HEADLESS !== "false" });
  const page = await ctx.newPage();

  let cards = [], packs = [], serials = [];
  const enumPskus = new Set();
  // Native response interception — no in-page hook, no signing, no token handling here.
  // resp.json() reads the CDP-layer body regardless of how the page consumes it.
  page.on("response", async (resp) => {
    if (!resp.url().includes("/onepanini") || resp.status() !== 200) return;
    let j; try { j = await resp.json(); } catch { return; }
    const d = j?.data; if (!d) return;
    if (d.getCardMarketStats?.data) cards.push(d.getCardMarketStats.data);
    if (d.getPackMarketStats?.data) packs.push(d.getPackMarketStats.data);
    const prods = d.getPskuTotalCardsList?.data?.products;
    if (Array.isArray(prods)) serials.push(...prods);
    // grid enumeration: { data: { products: { items: [ {psku,...} ] } } }
    const items = d.products?.items;
    if (Array.isArray(items)) for (const it of items) if (it?.psku && it.psku.startsWith(WC_PREFIX)) enumPskus.add(it.psku);
  });

  // --- 1. ENUMERATE: walk the Soccer grid, scroll to paginate, collect WC Prizm pskus ---
  await page.goto(`${BASE}/marketplace/nfts.html?sport=Soccer`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  let last = -1, stable = 0;
  for (let i = 0; i < 80 && stable < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    const n = enumPskus.size;
    if (n === last) stable++; else stable = 0;
    last = n;
  }
  const fileList = loadPskus();
  const pskus = enumPskus.size > 0 ? [...enumPskus] : fileList;
  console.log(`[panini-runner] enumerated ${enumPskus.size} WC-Prizm pskus (file fallback had ${fileList.length}); walking ${pskus.length}`);

  // --- 2. PACKS ---
  for (const url of PACK_URLS) {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(900);
  }

  // --- 3. Per-card detail (getCardMarketStats + getPskuTotalCardsList serials) ---
  for (const psku of pskus) {
    await page.goto(`${BASE}/marketplace-details/${psku}.html`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(900);
    if (cards.length + serials.length >= BATCH) { await post({ cards, serials }); cards = []; serials = []; }
  }
  await post({ cards, packs, serials });
  await ctx.close();
}

main().catch((e) => { console.error("[panini-runner] fatal:", e); process.exit(1); });
