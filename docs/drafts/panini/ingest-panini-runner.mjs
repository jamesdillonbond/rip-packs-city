// ingest-panini-runner.mjs — Panini Plane-A residential runner.
//
// ⚠⚠ SUPERSEDED 2026-08-16 — THIS FILE IS FROZEN HISTORY. THE LIVE RUNNER IS
// `scripts/ingest-panini-runner.mjs` (~34 KB vs this 4 KB draft), on Windows Task Scheduler
// every 4h since 2026-07-25. Read the contract there, never here. Kept only because it is the
// draft the go-live buildkit was written against.
//
// Do not treat anything below as current. Three ways this file actively misleads:
//   1. `loadPskus()` returns ONE hardcoded sample; the live runner enumerates via a dual path
//      (network getMarketPlaceList interception + a DOM harvest of the virtualized grid).
//   2. PACK_URLS is missing FOTL and carries a stale Hobby listing id.
//   3. ⚠ The psku sample below encodes the OLD, WRONG field order. The format is
//      `packcard-<setId>_<parallelSetId>_<cardId>_<playerId>` (corrected 2026-07-19 — the last
//      two fields were swapped). CLAUDE.md flags this exact correction; a session reading the
//      shape off this draft reproduces the bug the correction exists to prevent.
//
// All three TODOs below are RESOLVED — see each one in place.
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
  // TODO(go-live) RESOLVED 2026-07-16 — FOTL was captured as pack_id 1039 and is live in
  // scripts/ingest-panini-runner.mjs alongside Hobby (1038). Craft/challenge packs were NOT
  // added and that is deliberate, not an omission: they have no marketplace listing page to
  // walk. Do not re-open this against the draft's stale Hobby listing id above.
];

// Edition pages: /marketplace-details/<psku>.html
// TODO(go-live) RESOLVED 2026-07-16/19 — the live runner enumerates by BOTH (a) intercepting
// the grid getMarketPlaceList response and (b) scrolling the virtualized grid and scraping
// packcard-<...> pskus out of the card-image srcs, because (a) alone misses cards whose
// response fired before the listener attached. ⚠ Enumeration is LISTING-GATED and cannot be
// completed here — an edition enters the index only once listed, so coverage is a floor, not a
// census (measured 38.8% on 2026-08-02 and it drifts as the denominator grows). Panini exposes
// no full-checklist route, so the answer shipped was to DISCLOSE the gap on the public surface
// (panini_coverage_summary → the "floor, not a census" banner + meta.coverage), not to finish
// this list. Do not re-derive the dead ends (crafted GQL → 426, offline psku derivation).
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
