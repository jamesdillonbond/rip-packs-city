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
//                          the enumeration harvested live from the grid — the
//                          getMarketPlaceList network capture (a) plus the card-image
//                          URL scrape (b); see the ENUMERATION notes below.
//   PANINI_OPS_CAPTURE_FILE (optional) JSONL path for the /onepanini REQUEST+response
//                          operation capture (default panini-ops-capture.jsonl). Every
//                          run appends one line per /onepanini exchange: the request
//                          postData (the GraphQL op + variables the SPA actually sent),
//                          HTTP status, response data keys, and item counts. This is the
//                          instrument for finding a NON-marketplace enumeration op — the
//                          #1 Panini go-live blocker (discovery is listing-GATED via
//                          getMarketPlaceList; see the 2026-07-19 handoff).
//   PANINI_DISCOVERY_HOLD_MIN (optional) if >0, after attaching the capture listener the
//                          runner opens the site and WAITS this many minutes so YOU can
//                          click through set/checklist/"collection" browse views, a
//                          cardset-filtered marketplace grid, and card detail pages in
//                          the CDP Chrome — every /onepanini request body those views
//                          fire lands in the ops-capture file. Use with PANINI_CDP_URL.
//   PANINI_DISCOVERY_ONLY  (optional) "1" = exit after the discovery hold (skip the
//                          grid walk entirely) — for a quick manual capture session.
//   PANINI_SALES_HISTORY   (optional) "0" = do NOT open each card's SALES HISTORY tab.
//                          Kill switch for the realized-sales capture (see SALES below) if it
//                          ever costs too much walk budget or draws 429s; the rest of the walk
//                          is unaffected.
//
// SALES (2026-08-08 — the replacement price path). getPskuTotalCardsList's brought_at_price has
// been JSON null for every serial since 2026-07-29 and NO request shape recovers it: the A/B
// varied listType across all four real values plus a nonsense control and got the identical 10
// rows / 10 nulls each time, from a fully signed request on Panini's own front end. Realized
// prices instead come from op `nftSalesData` (url_key = our panini_card_serials.sku exactly,
// txn_amount = price, purchased_date, buyer/seller/hash/sale_type).
// ⚠ That op does NOT fire on a card detail page load — measured over 33,692 captured /onepanini
// exchanges, nftSalesData appears ZERO times while getCardMarketStats appears 2,477. It fires
// only when the SALES HISTORY tab is ACTIVATED, so capturing it is not just a listener filter:
// the walk has to click the tab (openSalesHistory below). Clicking lets the SPA build and sign
// the request natively — the runner never constructs one (a hand-built POST gets 426).

import { chromium } from "playwright";
import fs from "node:fs";
import readline from "node:readline";
// Pure enumeration-progress helpers, extracted so the stop decision is unit-testable without a
// browser (this file calls main() at import). See panini-enum-progress.mjs for the full why.
import { enumProgress, stepStability, enumStopReason } from "./panini-enum-progress.mjs";
import { tagSaleRecords } from "./panini-sales-list.mjs";

const USER_DATA_DIR = process.env.PANINI_USER_DATA_DIR;
const INGEST_URL = process.env.RPC_PANINI_INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN;
const BASE = "https://nft.paniniamerica.net";

// Pack pages: /marketplace-details/subpack-<x>-<pack_id>.html  (Hobby pack_id 1038 confirmed).
// MULTI-PRODUCT (2026-09-28): the pack list now comes from the DB (panini_pack_pages, served by the
// ingest route's GET as `pack_urls`) plus whatever pack links this walk harvests. This array is only
// the FALLBACK for when that read fails, so a registry outage keeps today's WC coverage.
// WC2026 Prizm World Cup Soccer packs (both captured live via Chrome 2026-07-16):
const PACK_URLS = [
  `${BASE}/marketplace-details/subpack-5270763-1038.html`, // Hobby  (pack_id 1038) — live: ~9,504 unopened, floor ~$249
  `${BASE}/marketplace-details/subpack-5294230-1039.html`, // FOTL   (pack_id 1039) — captured 07-16
  // Add craft/challenge packs here if RPC decides to cover them.
];

// Edition pages: /marketplace-details/<psku>.html
// psku format (CORRECTED 2026-07-19 — the old comment had the last two fields swapped):
//   packcard-<setId>_<parallelSetId>_<cardId>_<playerId>
// Field 2 has 54 distinct values (= the 54 parallel-set names), field 4 has 474 (= the
// checklist players). playerId is NOT derivable from cardId (41 distinct offsets within
// Base Prizms Red alone), so pskus cannot be constructed offline — see
// docs/handoff-2026-07-19-panini-catalog-and-candy-offers.md before re-attempting.
// The Soccer grid mixes >=5 products; the WC2026 Prizm setId is CONFIRMED = 2332 (verified live
// 2026-07-16 on Base Prizms Red/Silver + Prizmania cards). SCOPE the harvest to packcard-2332_*.
// Card detail DOM labels map to the API fields: UNCLAIMED=unopened_pack_count(still_in_packs),
// WITH COLLECTORS=with_collectors_count(pulled), BURNED=burned_count, REMAINING SUPPLY=end_seq(mint_cap). Enumeration on the box: this Playwright runner's
// page.on("response") intercepts /onepanini at the NETWORK layer (a page-context fetch/XHR
// override does NOT work — the app closes over fetch before injection; verified 07-16).
// Harvest by BOTH (a) intercepting the grid getMarketPlaceList response (page.on("response")
// below), AND (b) scrolling the virtualized grid and collecting packcard-<...> pskus from the
// card image URLs (harvestDomPskus, merged into the same enumPskus set during the scroll loop) —
// (b) recovers cards whose getMarketPlaceList fired before the listener attached or that the SPA
// re-rendered from its store without a fresh fetch.
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

const BACKUP_FILE = process.env.PANINI_BACKUP_FILE || "panini-capture.jsonl";
// Size cap (2026-08-13). This appends EVERY batch of EVERY 4-hourly walk, forever, and nothing
// prunes it on success — measured 1.27 GB on Trevor's box after ~4 weeks live. The disk is the
// small half. The real defect: scripts/panini-replay.mjs does readFileSync(file, "utf8"), and
// Node's MAX_STRING_LENGTH is 536,870,888 bytes on 64-bit, so past ~512 MB the recovery tool this
// backup EXISTS to feed can no longer read it — the safety net stops being a safety net silently,
// and you only discover it at the moment you need it. (replay now streams, but keep the bound:
// the recovery window is one walk, so batches older than a day or two have no consumer at all.)
// Same treatment as the ops-capture file below — rotate rather than truncate, so a recovery that
// is already in flight keeps its evidence. Override with PANINI_BACKUP_MAX_BYTES.
const BACKUP_MAX_BYTES = Number(process.env.PANINI_BACKUP_MAX_BYTES || 100 * 1024 * 1024);
let backupBytes = -1; // lazily seeded from the existing file, then tracked in-process
function appendBackup(line) {
  try {
    if (backupBytes < 0) { try { backupBytes = fs.statSync(BACKUP_FILE).size; } catch { backupBytes = 0; } }
    if (backupBytes + line.length > BACKUP_MAX_BYTES) {
      try { fs.renameSync(BACKUP_FILE, BACKUP_FILE + ".1"); } catch {}
      backupBytes = 0;
    }
    fs.appendFileSync(BACKUP_FILE, line);
    backupBytes += line.length;
  } catch {}
}
async function post(payload) {
  const n = (payload.cards?.length || 0) + (payload.packs?.length || 0) + (payload.serials?.length || 0) + (payload.sales?.length || 0)
    + (payload.products?.length || 0) + (payload.pack_pages?.length || 0);
  // An enum-only payload carries no rows but IS worth posting: it is the only record of how much
  // of the grid this walk actually enumerated, and that number previously existed nowhere except
  // a console line nobody reads and a size-capped local JSONL that rotates. A walk that enumerates
  // far less than usual is otherwise indistinguishable from a walk that ran normally.
  if (!n && !payload.enum) return;
  // ALWAYS append the batch to a local backup first — a captured walk is never lost to a bad token;
  // scripts/panini-replay.mjs can POST the file once auth is fixed (no re-walk).
  appendBackup(JSON.stringify(payload) + "\n");
  // Retry transient POST failures (network blip / cold lambda). The batch is already in the backup
  // file, so a permanent failure is recoverable via scripts/panini-replay.mjs — but retrying here
  // means a blip doesn't silently cost a batch of live data.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(INGEST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_TOKEN}` },
        body: JSON.stringify(payload),
      });
      console.log(`[panini-runner] posted cards=${payload.cards?.length||0} packs=${payload.packs?.length||0} serials=${payload.serials?.length||0} sales=${payload.sales?.length||0} -> ${r.status}${attempt>1?` (attempt ${attempt})`:""}`);
      if (r.ok || r.status === 401 || r.status === 403) return; // 4xx auth won't fix on retry
    } catch (e) {
      console.log(`[panini-runner] post attempt ${attempt} failed: ${e.message}`);
    }
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt * 1500));
  }
  console.log("[panini-runner] post FAILED after 3 attempts — batch preserved in the backup file; replay with scripts/panini-replay.mjs");
}

// Our own catalogue, stalest first. Added 2026-09-19 — see the long WHY on the GET arm of
// app/api/cron/panini-ingest/route.ts. Returns [] on ANY failure so the caller degrades to the
// old shuffle rather than to a fixed order (which would be worse than what we had).
async function fetchWalkOrder() {
  try {
    // No `limit` — the runner needs the WHOLE catalogue. A trimmed list would make every
    // recently-walked edition look like a brand-new discovery to the classifier below, and
    // brand-new discoveries are walked FIRST. `complete` is the route's own statement that
    // nothing was paged off or trimmed; without it the classifier must not run.
    const r = await fetch(INGEST_URL, { headers: { Authorization: `Bearer ${INGEST_TOKEN}` } });
    if (!r.ok) { console.log(`[panini-runner] walk-order GET -> ${r.status}; falling back to shuffle`); return { list: [], complete: false }; }
    const j = await r.json();
    // Walk scope first: the route says which products' cards to walk. Absent (an older deploy) or
    // empty -> the historical WC-only scope, never "everything".
    const sids = Array.isArray(j?.walk_set_ids) ? j.walk_set_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (sids.length) WALK_SETS = new Set(sids);
    if (Array.isArray(j?.discovery_sports) && j.discovery_sports.length) DISCOVERY_SPORTS = j.discovery_sports.filter((x) => typeof x === "string" && x);
    if (Array.isArray(j?.full_enum_sports) && j.full_enum_sports.length) FULL_ENUM_SPORTS = new Set(j.full_enum_sports.filter((x) => typeof x === "string"));
    if (Array.isArray(j?.pack_urls)) SERVED_PACK_URLS = j.pack_urls.filter((x) => typeof x === "string" && x.startsWith(BASE + "/"));
    const list = Array.isArray(j?.pskus) ? j.pskus.filter((x) => typeof x === "string" && isWalked(x)) : [];
    const complete = j?.complete === true;
    console.log(`[panini-runner] walk order: ${list.length} known pskus, stalest first, complete=${complete} (oldest last_seen_at ${j?.oldest_last_seen_at ?? "?"}); walk sets=[${[...WALK_SETS].join(",")}] sports=[${DISCOVERY_SPORTS.join(",")}] pack pages=${SERVED_PACK_URLS ? SERVED_PACK_URLS.length : "fallback"}`);
    return { list, complete };
  } catch (e) {
    console.log(`[panini-runner] walk-order GET failed: ${e.message}; falling back to shuffle`);
    return { list: [], complete: false };
  }
}

// (WC_PREFIX "packcard-2332_" retired 2026-09-28: the product gate is WALK_SETS / isWalked below;
// 2332 = WC2026 Prizm World Cup Soccer, verified live 2026-07-16.)
// MULTI-PRODUCT (2026-09-28). A psku's field 1 is its card PRODUCT (2332 = WC Prizm). The runner
// sees every product each sport's grid serves (and reports them — that is how the panini_products
// registry fills), but only WALKS the products the ingest route names in walk_set_ids. The defaults
// below are the pre-registry behaviour, used whenever the route cannot be read.
let WALK_SETS = new Set([2332]);
let DISCOVERY_SPORTS = ["Soccer"];
let FULL_ENUM_SPORTS = new Set(["Soccer"]);
let SERVED_PACK_URLS = null; // null = the route did not answer -> PACK_URLS fallback
function setIdOf(psku) {
  const m = typeof psku === "string" ? psku.match(/^packcard-(\d+)_/) : null;
  return m ? Number(m[1]) : null;
}
function isWalked(psku) { const sid = setIdOf(psku); return sid !== null && WALK_SETS.has(sid); }
// Pack links on any page the walk visits: marketplace subpack pages and /pack-<name>.html drop pages.
// 2026-09-29: the site links drop pages WITHOUT ".html" (/pack-2026_Panini_NFT_Prizm_WNBA_Packs), so
// the first version (".html" required) harvested 0 links while those two sat in packish_unmatched.
// ".html" is optional here and added back by packPageKey, so both spellings are one page.
const PACK_LINK_RE = /^https:\/\/nft\.paniniamerica\.net\/(?:marketplace-details\/subpack-\d+-\d+|pack-[^/?#.]+)(?:\.html)?$/;
function packPageKey(u) { return u.endsWith(".html") ? u : u + ".html"; }

async function main() {
  const CDP = process.env.PANINI_CDP_URL; // e.g. http://localhost:9222 — connect to YOUR real logged-in Chrome
  if (!INGEST_URL || !INGEST_TOKEN) throw new Error("missing env (RPC_PANINI_INGEST_URL / INGEST_SECRET_TOKEN)");
  if (!CDP && !USER_DATA_DIR) throw new Error("set PANINI_CDP_URL (recommended — connect to your real Chrome) OR PANINI_USER_DATA_DIR");

  let ctx, browser = null;
  if (CDP) {
    // RECOMMENDED for bot-walled Panini: drive your OWN Chrome (real fingerprint + your live
    // login + wallet session). Launch it first with:
    //   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:/Users/TDill/panini-cdp-profile"
    // log into Panini there once, then run this with PANINI_CDP_URL=http://localhost:9222
    browser = await chromium.connectOverCDP(CDP);
    ctx = browser.contexts()[0] || await browser.newContext();
    console.log(`[panini-runner] connected over CDP (${CDP}) — using your real Chrome`);
  } else {
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, { headless: process.env.PANINI_HEADLESS !== "false" });
  }
  let page = ctx.pages().find((pg) => !pg.isClosed()) || await ctx.newPage();

  // PREFLIGHT: empty POST returns 202 on good auth, 401 on bad token — fail fast before the walk.
  {
    const pf = await fetch(INGEST_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_TOKEN}` }, body: "{}" });
    if (pf.status !== 202) {
      console.error(`[panini-runner] AUTH PREFLIGHT FAILED: POST ${INGEST_URL} -> ${pf.status}. Your INGEST_SECRET_TOKEN does not match the deployed route (it accepts INGEST_SECRET_TOKEN or CRON_SECRET). Fix the token and rerun; not walking cards.`);
      if (CDP) { await browser.close().catch(() => {}); } else { await ctx.close().catch(() => {}); }
      process.exit(3);
    }
    console.log("[panini-runner] auth preflight OK (202)");
  }

  let cards = [], packs = [], serials = [], sales = [];
  const enumPskus = new Set();
  let currentPackId = null; // set before each pack-page goto so packs get their real id
  let currentPackUrl = null; // ...and the page they came from (panini_pack_state.page_url)
  const nationByPsku = {}; // psku -> country (only the grid list carries team; per-card API does not)
  let opCount = 0; const dataKeys = new Set();
  let salesRecords = 0, salesPages = 0, salesTabMissed = 0;
  // Which list each sale record came from (2026-09-28): the ingest keeps every record in
  // panini_sales, and only RECENT-list records move an edition's coverage. untagged > 0 means the
  // request's list field was not recognised (scripts/panini-sales-list.mjs).
  const salesByList = { top: 0, recent: 0, untagged: 0 };
  // Grid-enumeration progress (2026-08-15). Counts EVERY product the grid returns, not just the
  // WC-Prizm subset, because the stability heuristic below has to be able to tell "the grid is
  // exhausted" apart from "this stretch of the grid happens to be other soccer product". The
  // marketplace grid the walk scrolls is filtered ONLY by sport=Soccer (confirmed live: the
  // products op sends applied_filters:"marketplace-nfts?sport=Soccer&p=N"), and it mixes >=5
  // products — so WC cards arrive in clumps and a WC-only progress signal reads a run of
  // non-WC pages as "no new cards" and stops the walk while the server is still serving.
  let gridSeen = 0, gridPages = 0;
  // Product sightings for the registry: setId -> { sport, items } (the sport whose grid served it
  // most this walk). Fed by BOTH enumeration sources, for EVERY product, walked or not.
  let currentSport = null;
  const sightings = new Map();
  // One grid item per setId (the first seen), so a product can be IDENTIFIED — a setId alone does
  // not say "WNBA" (2026-09-28: 129 setIds sighted, none nameable). Stored as panini_products.sample.
  const sampleBySet = new Map();
  function sampleOf(it) {
    const sid = setIdOf(String(it?.psku ?? ""));
    if (sid === null || sampleBySet.has(sid)) return;
    const pick = (v) => (typeof v === "string" ? v.slice(0, 120) : v ?? null);
    sampleBySet.set(sid, { psku: pick(it.psku), athlete: pick(it.athlete), team: pick(it.team), cardset: pick(it.cardset), rarity: pick(it.rarity) });
  }
  // Pack-page evidence (2026-09-28): the WNBA /pack-<name>.html page was walked and captured
  // nothing, so record WHAT each pack-page visit fired, and the first response object that looks
  // like pack data from ANY operation. Read back as panini_pack_pages.last_ops / last_pack_like.
  let packVisitOps = null, packVisitPackLike = null;
  function opNameOf(resp) {
    try {
      const pj = JSON.parse(resp.request().postData() || "null");
      return pj?.operationName || (typeof pj?.query === "string" ? (pj.query.match(/(?:query|mutation)\s+(\w+)/) || [])[1] : null) || "unknown";
    } catch { return "unknown"; }
  }
  function findPackLike(o, depth) {
    if (!o || typeof o !== "object" || depth > 6) return null;
    if (!Array.isArray(o) && (o.pack_sku != null || o.total_pack_qty != null)) return o;
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") { const r = findPackLike(v, depth + 1); if (r) return r; } }
    return null;
  }
  function sight(psku) {
    const sid = setIdOf(psku);
    if (sid === null) return;
    const k = `${sid}|${currentSport ?? "?"}`;
    sightings.set(k, (sightings.get(k) || 0) + 1);
  }
  // Pack links harvested from every page the walk visits (discovery -> panini_pack_pages).
  const harvestedPackUrls = new Set();
  const packishUnmatched = new Set();
  async function harvestPackLinks() {
    let hrefs = [];
    try {
      hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.href || ""));
    } catch { return 0; }
    let added = 0;
    for (const h of hrefs) {
      const u = String(h).split("#")[0].split("?")[0];
      if (PACK_LINK_RE.test(u)) { const k = packPageKey(u); if (!harvestedPackUrls.has(k)) { harvestedPackUrls.add(k); added++; } }
      // Evidence for the pattern itself (0 links matched on 2026-09-28): keep a few pack-ish hrefs
      // that did NOT match, so a wrong PACK_LINK_RE is visible in the enum marker.
      else if (/pack/i.test(u) && packishUnmatched.size < 15) packishUnmatched.add(u.slice(0, 200));
    }
    return added;
  }
  const DEBUG = process.env.PANINI_DEBUG === "1";
  // Recursively find every realized-sale record in an nftSalesData payload. Keyed on the FIELDS
  // that were verified live (url_key + txn_amount) rather than a nesting path, because the op was
  // observed on exactly ONE psku — a shape assumption drawn from n=1 is the thing most likely to
  // be wrong here, and a field match survives it. Stops descending at a matched record.
  function findSaleRecords(o, depth, out) {
    if (!o || typeof o !== "object" || depth > 6) return;
    if (Array.isArray(o)) { for (const v of o) findSaleRecords(v, depth + 1, out); return; }
    if (o.url_key != null && o.txn_amount != null) { out.push(o); return; }
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") findSaleRecords(v, depth + 1, out); }
  }
  // Recursively find every {items:[...]} array anywhere in the payload (enumeration shape can vary).
  function findItems(o, depth, out) {
    if (!o || typeof o !== "object" || depth > 5) return;
    if (Array.isArray(o.items)) out.push(...o.items);
    for (const k in o) { const v = o[k]; if (v && typeof v === "object") findItems(v, depth + 1, out); }
  }
  // /onepanini operation capture (2026-07-19): record every REQUEST payload the SPA
  // sends (op + variables) alongside what came back, so a capture session can answer
  // "is there any operation that returns cards independent of listing status?" —
  // the decision question for replacing listing-gated enumeration. Appends JSONL;
  // failures are swallowed (capture must never break the scheduled ingest run).
  const OPS_FILE = process.env.PANINI_OPS_CAPTURE_FILE || "panini-ops-capture.jsonl";
  // Size cap: this runs on Trevor's residential box every 4h forever, and each walk appends
  // a few hundred lines (request payloads truncated to 20k each). Without a bound that is
  // ~3-4 MB/day compounding with nothing ever reading it. Keep ONE rotated generation so a
  // capture session's evidence survives, then start fresh. Override with the env var.
  const OPS_MAX_BYTES = Number(process.env.PANINI_OPS_CAPTURE_MAX_BYTES || 25 * 1024 * 1024);
  let opsBytes = -1; // lazily seeded from the existing file, then tracked in-process
  function captureOp(resp, parsed) {
    try {
      const req = resp.request();
      const post = req.postData() || null;
      let opName = null;
      if (post) {
        try {
          const pj = JSON.parse(post);
          opName = pj?.operationName || (typeof pj?.query === "string" ? (pj.query.match(/(?:query|mutation)\s+(\w+)/) || [])[1] : null) || null;
        } catch {}
      }
      const d = parsed?.data;
      const counts = {};
      if (d && typeof d === "object") {
        for (const k in d) {
          const items = [];
          findItems(d[k], 0, items);
          counts[k] = items.length;
        }
      }
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        page: page.url(),
        status: resp.status(),
        op: opName,
        data_keys: d && typeof d === "object" ? Object.keys(d) : null,
        item_counts: counts,
        request: post ? post.slice(0, 20000) : null,
      }) + "\n";
      if (opsBytes < 0) { try { opsBytes = fs.statSync(OPS_FILE).size; } catch { opsBytes = 0; } }
      if (opsBytes + line.length > OPS_MAX_BYTES) {
        // Rotate rather than truncate so an in-flight capture session isn't lost.
        try { fs.renameSync(OPS_FILE, OPS_FILE + ".1"); } catch {}
        opsBytes = 0;
      }
      fs.appendFileSync(OPS_FILE, line);
      opsBytes += line.length;
    } catch {}
  }
  // Native response interception — resp.text() then JSON.parse (some content-types aren't application/json,
  // so resp.json() can throw; parse text ourselves).
  page.on("response", async (resp) => {
    if (!resp.url().includes("/onepanini")) return;
    let j = null; try { j = JSON.parse(await resp.text()); } catch {}
    captureOp(resp, j); // non-200s (e.g. the 426 wall) are informative — captured too
    if (resp.status() !== 200 || !j) return;
    const d = j?.data; if (!d) return;
    opCount++; for (const k in d) dataKeys.add(k);
    if (packVisitOps) {
      const op = opNameOf(resp);
      packVisitOps[op] = (packVisitOps[op] || 0) + 1;
      if (!packVisitPackLike) { const pl = findPackLike(d, 0); if (pl) packVisitPackLike = { op, keys: Object.keys(pl).slice(0, 60), pack_sku: pl.pack_sku ?? null, pack_name: pl.pack_name ?? null }; }
      // Drop pages (/pack-<name>.html) carry their data in op packDetails, not getPackMarketStats
      // (measured 2026-09-29 on the WNBA FOTL page), and findPackLike saw no pack_sku in it. Keep a
      // truncated copy of that payload so its shape can be read before anything is built on it.
      if (op === "packDetails" && !packVisitPackLike?.sample) {
        let sample = null; try { sample = JSON.stringify(d).slice(0, 3000); } catch {}
        packVisitPackLike = { ...(packVisitPackLike ?? { op }), details_keys: Object.keys(d?.packDetails ?? d ?? {}).slice(0, 60), sample };
      }
    }
    if (d.getCardMarketStats?.data) { const cd = d.getCardMarketStats.data; if (cd.psku && nationByPsku[cd.psku]) cd.__nation = nationByPsku[cd.psku]; cards.push(cd); }
    if (d.getPackMarketStats?.data) { const pk = d.getPackMarketStats.data; if (currentPackId) pk.__pack_id = currentPackId; if (currentPackUrl) pk.__page_url = currentPackUrl; packs.push(pk); }
    // DROP pages (/pack-<name>.html) carry op packDetails instead: Panini's own primary listing —
    // pack_id, pack_name, collection_name, sport, subpack_price, pack_label, in_stock (read from the
    // 2026-09-29 samples of the WNBA FOTL 1055 / WNBA 1056 pages). No market stats (no floor, no
    // unopened count), so those stay null downstream; the pack id is Panini's own numeric id.
    else if (currentPackUrl && d.packDetails?.data?.pack_id != null) {
      const pk = { ...d.packDetails.data, __pack_id: String(d.packDetails.data.pack_id), __page_url: currentPackUrl, __source: "packDetails" };
      packs.push(pk);
    }
    const prods = d.getPskuTotalCardsList?.data?.products;
    if (Array.isArray(prods)) serials.push(...prods);
    const saleRecs = []; findSaleRecords(d, 0, saleRecs);
    if (saleRecs.length) {
      const list = tagSaleRecords(saleRecs, resp.request().postData() || "");
      salesByList[list ?? "untagged"] += saleRecs.length;
      sales.push(...saleRecs); salesRecords += saleRecs.length;
    }
    // Grid page accounting, read from the products op SPECIFICALLY (not findItems, which
    // recurses into every {items:[]} in any payload and would count menu/category noise as
    // enumeration progress). This is the denominator for the WC-share diagnostic below.
    const gridItems = d.products?.items;
    if (Array.isArray(gridItems)) { gridSeen += gridItems.length; gridPages++; }
    const items = []; findItems(d, 0, items);
    for (const it of items) {
      if (!it?.psku) continue;
      if (Array.isArray(gridItems) && gridItems.includes(it)) { sight(String(it.psku)); sampleOf(it); }
      if (isWalked(String(it.psku))) { enumPskus.add(it.psku); if (it.team) nationByPsku[it.psku] = it.team; }
    }
    if (DEBUG && items.length) console.log(`[panini-runner][debug] onepanini keys=${Object.keys(d).join(",")} items=${items.length} walked=${[...enumPskus].length}`);
  });

  // (b) DOM harvest — the documented fallback enumeration source. The virtualized grid
  // renders each card as an <img> whose URL embeds the full psku
  // (packcard-<setId>_<parallelSetId>_<cardId>_<playerId>), so scraping those srcs recovers
  // cards whose getMarketPlaceList response fired before the network listener attached, or
  // that the SPA re-rendered from its store without a fresh fetch. Purely additive: merges
  // into the same deduped enumPskus set the network path (a) feeds, scoped to WC_PREFIX
  // exactly like (a). Never throws (a scrape failure must not break the scheduled run);
  // returns how many NEW pskus it added.
  async function harvestDomPskus() {
    let srcs = [];
    try {
      srcs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('img[src*="packcard-"]')).map((el) => el.getAttribute("src") || "")
      );
    } catch { return 0; }
    let added = 0;
    for (const src of srcs) {
      // Require the FULL 4-field psku (setId_parallelSetId_cardId_playerId), matching the
      // exact shape the network path adds at getMarketPlaceList and the shape the detail-page
      // walk navigates to. A stricter match than "any packcard-<digits>" so a thumbnail that
      // embeds only a truncated base key never pollutes the walk with a non-resolving psku —
      // worst case (b) simply adds nothing, same as before it existed.
      const m = src.match(/packcard-[0-9]+_[0-9]+_[0-9]+_[0-9]+/);
      if (!m) continue;
      const psku = m[0];
      if (isWalked(psku) && !enumPskus.has(psku)) { enumPskus.add(psku); added++; }
    }
    return added;
  }

  // SALES HISTORY activation. The detail page loads getCardMarketStats + getPskuTotalCardsList on
  // its own but fires nftSalesData ONLY when this tab is opened, so the walk has to click it. The
  // label/role is not pinned in any capture we hold, so try a ladder of locators and give up
  // quietly — this must never break a walk that is otherwise capturing editions + serials, and a
  // silent failure is visible in the salesTabMissed counter rather than as a stall.
  const SALES_HISTORY = process.env.PANINI_SALES_HISTORY !== "0";
  async function openSalesHistory() {
    if (!SALES_HISTORY) return false;
    const before = sales.length;
    const candidates = [
      () => page.getByRole("tab", { name: /sales\s*history/i }).first(),
      () => page.getByRole("button", { name: /sales\s*history/i }).first(),
      // Anchored text so a page-level container that merely CONTAINS the phrase never matches.
      () => page.locator('a, button, li, [role="tab"]').filter({ hasText: /^\s*sales\s*history\s*$/i }).first(),
    ];
    for (const mk of candidates) {
      try {
        const el = mk();
        await el.waitFor({ state: "visible", timeout: 1200 });
        await el.click({ timeout: 2500 });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && sales.length === before) await page.waitForTimeout(150);
        if (sales.length > before) return true;
      } catch { /* locator absent / not clickable — try the next shape */ }
    }
    return false;
  }

  // RECENT SALES (2026-09-24). The SALES HISTORY tab opens on "TOP SALES / ALL TIME" — the 20
  // HIGHEST-PRICED sales ever (nftSalesData sale_type:"top", pageSize 20), NOT the latest. That was
  // the only list this runner ever read, so last_sale_usd/_at were drawn from a price-sorted sample:
  // probed live on Maradona Base Prizms Silver, the eight sales of 09-05..09-15 ($14-$25) were all
  // absent from the DB (newest recorded: 07-20) while top sales ran $55-$650, and the edition's
  // published FMV sat at $40.93. Switching the dropdown to RECENT SALES fires one more nftSalesData
  // (the SPA signs it) that the response listener already parses. Fail-soft, never throws; the
  // monotonic last_sale_at guard in the ingest route keeps an older TOP record from overwriting a
  // newer RECENT one, whichever lands second. Kill switch PANINI_SALES_RECENT=0.
  const SALES_RECENT = process.env.PANINI_SALES_RECENT !== "0";
  let recentPages = 0, recentMissed = 0;
  async function openRecentSales() {
    if (!SALES_RECENT) return false;
    const before = sales.length;
    try {
      // DOM click, not a Playwright pointer click: measured 2026-09-24 10 AM PT walk, the pointer
      // path fired the RECENT request on 3 of ~300 cards (it dies on actionability/hit-testing in
      // the CDP window), while the same two elements clicked via el.click() fire it every time —
      // which is exactly how the switch was probed live before shipping.
      await page.locator("button.dropdown-toggle").filter({ hasText: /^\s*top\s*sales\s*$/i }).first().evaluate((el) => el.click(), undefined, { timeout: 2500 });
      await page.waitForTimeout(400);
      await page.locator("a.dropdown-item").filter({ hasText: /^\s*recent\s*sales\s*$/i }).first().evaluate((el) => el.click(), undefined, { timeout: 2500 });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && sales.length === before) await page.waitForTimeout(150);
      return sales.length > before;
    } catch { return false; }
  }

  // SERIAL PAGING (2026-09-23). getPskuTotalCardsList is paged at `l: 30` and the detail page
  // only requests page 1 on load, so without this every walk re-read at most 30 serials per
  // card: measured max(serials captured in an edition's latest walk) = 30 EXACTLY, 48% of serial
  // asks un-re-read for 7+ days, and 41% of sold serials unmatched (sales_missed) because the
  // serial had never been discovered. The serial table is an infinite scroll: scrolling the
  // WINDOW to the bottom makes the SPA request p:2, p:3, … and sign them natively (probed live
  // 2026-09-23 on a 259-serial card: 30 -> 259 in 7 pages, ~1 s each). The response listener
  // above already captures every getPskuTotalCardsList page, so this only has to scroll.
  // Stops on a short page (rows % 30 != 0 means the last page arrived), on no growth within
  // SERIAL_PAGE_WAIT_MS, or at SERIAL_PAGES_MAX extra pages. Never throws. Kill switch
  // PANINI_SERIAL_PAGES=0. The signal it worked is DB-side, not console-side (the console is
  // masked to Cowork): panini_serial_freshness.max_serials_per_edition_walk rises above 30.
  const SERIAL_PAGES_MAX = Number(process.env.PANINI_SERIAL_PAGES ?? 12);
  const SERIAL_PAGE_WAIT_MS = 2500;
  let serialExtraPages = 0, serialPagedCards = 0;
  const serialStops = {};
  async function loadAllSerialPages() {
    if (!(SERIAL_PAGES_MAX > 0)) return;
    let r = null;
    try {
      r = await page.evaluate(async ({ max, wait }) => {
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const tbl = [...document.querySelectorAll("table")].find((t) => /SERIAL\s*NO/i.test((t.innerText || "").slice(0, 80)));
        if (!tbl) return { pages: 0, stop: "no-table" };
        const rows = () => tbl.querySelectorAll("tbody tr").length;
        let pages = 0, stop = "max";
        for (let k = 0; k < max; k++) {
          const before = rows();
          if (before === 0 || before % 30 !== 0) { stop = "short-page"; break; }
          window.scrollBy(0, -200);
          await sleep(50);
          window.scrollTo(0, document.body.scrollHeight);
          window.dispatchEvent(new Event("scroll"));
          const t0 = Date.now();
          let n = before;
          while (Date.now() - t0 < wait) { await sleep(100); n = rows(); if (n > before) break; }
          if (n === before) { stop = "no-growth"; break; }
          pages++;
        }
        window.scrollTo(0, 0);
        return { pages, stop };
      }, { max: SERIAL_PAGES_MAX, wait: SERIAL_PAGE_WAIT_MS });
    } catch { r = { pages: 0, stop: "error" }; }
    if (r.pages > 0) { serialExtraPages += r.pages; serialPagedCards++; await page.waitForTimeout(400); } // let the last response land in the listener
    serialStops[r.stop] = (serialStops[r.stop] || 0) + 1;
  }

  // --- 0. FIRST-RUN LOGIN GRACE: on a fresh profile you must sign in once. With
  //     PANINI_HEADLESS=false, open the site and pause so you can log into Panini in the
  //     window; the persistent profile keeps the session for all later headless runs. ---
  if (!CDP && process.env.PANINI_HEADLESS === "false") {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    console.log("[panini-runner] >>> LOG INTO PANINI in the open window. Do NOT close the window. When you're logged in, come back here and press ENTER. <<<");
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("", () => { rl.close(); resolve(); });
    });
    // if the login page got closed/replaced, grab a live page (reopen if needed)
    if (page.isClosed()) page = ctx.pages().find((pg) => !pg.isClosed()) || await ctx.newPage();
  }

  // --- 0.5 DISCOVERY HOLD (manual op capture): with PANINI_DISCOVERY_HOLD_MIN set, park
  //     here while the operator clicks through set/checklist browse views, a cardset-
  //     filtered grid, and card detail pages in the CDP Chrome. Every /onepanini request
  //     body those views fire is appended to the ops-capture file by the listener above.
  //     The goal: find an operation that enumerates cards INDEPENDENT of listing status
  //     (getMarketPlaceList is listings-only — the coverage defect's root cause). ---
  const HOLD_MIN = Number(process.env.PANINI_DISCOVERY_HOLD_MIN || 0);
  if (HOLD_MIN > 0) {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    console.log(`[panini-runner] DISCOVERY HOLD: capturing /onepanini ops to ${OPS_FILE} for ${HOLD_MIN} min.`);
    console.log("[panini-runner] >>> In the Chrome window, browse: (a) any set/checklist/collection view, (b) the marketplace grid WITH a cardset filter applied, (c) a card detail page. <<<");
    const tHold = Date.now();
    while (Date.now() - tHold < HOLD_MIN * 60000) {
      await page.waitForTimeout(15000);
      console.log(`[panini-runner] discovery hold ${Math.round((Date.now() - tHold) / 60000)}/${HOLD_MIN} min — ops captured so far: ${opCount}`);
    }
    if (process.env.PANINI_DISCOVERY_ONLY === "1") {
      console.log(`[panini-runner] discovery-only run complete — ${opCount} /onepanini exchanges in ${OPS_FILE}; skipping the grid walk.`);
      if (CDP) { await browser.close().catch(() => {}); } else { await ctx.close().catch(() => {}); }
      return;
    }
  }

  // --- 0.9 WALK SCOPE: read the walk order FIRST (multi-product, 2026-09-28) — it carries which
  //     products to walk (walk_set_ids), which sports to enumerate and which pack pages to open, and
  //     enumeration below filters on the first. It used to be read after enumeration; the catalogue
  //     it returns is the same either way.
  const { list: known, complete: knownComplete } = await fetchWalkOrder();

  // Home page first: a cheap pass for pack links (new drops are linked from it), nothing else.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await harvestPackLinks();

  // --- 1. ENUMERATE: walk each sport's grid, scroll to paginate. Walked products' pskus go to the
  //     walk set; EVERY product's setId is recorded as a sighting. Sports holding a walked product
  //     get the full budget; the rest get a short DISCOVERY pass — it only has to see which setIds
  //     exist, so a new product (a WNBA release, say) is in the registry the next morning. ---
  const DISCOVERY_BUDGET_MS = Number(process.env.PANINI_DISCOVERY_BUDGET_MIN || 3) * 60000;
  const sportStats = [];
  let domAdded = 0;
  for (const sport of DISCOVERY_SPORTS) {
  currentSport = sport;
  const full = FULL_ENUM_SPORTS.has(sport);
  const gridSeen0 = gridSeen, gridPages0 = gridPages, enum0 = enumPskus.size;
  await page.goto(`${BASE}/marketplace/nfts.html?sport=${encodeURIComponent(sport)}`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  // Stop when the GRID stops yielding, not when the WC subset stops yielding. Progress is the
  // composite (WC pskus found + total products the grid has served): a stretch of non-WC soccer
  // still advances it, so dilution can no longer end the walk early, while a genuinely exhausted
  // grid stops advancing both terms and the run ends as before.
  //
  // Why this changed (2026-08-15): measured over 5 consecutive walks, the grid returned pages
  // 1..N sequentially, EVERY page exactly 30 items — never a short final page — and the walk
  // quit at 41, 11, 12, 18 and 15 pages. A grid that had run out of cards would stop at roughly
  // the same depth each time and end on a partial page. Arbitrary depths against full pages mean
  // the runner was quitting while inventory remained, which is why editions/day fell ~800 -> 153
  // with per-batch capture completely unchanged (2.16-3.11 editions/batch, zero failed batches).
  //
  // Bounded three ways so enumeration can never eat the walk budget it feeds: an iteration cap,
  // a wall-clock budget, and the stability counter. All three are env-overridable for a probe.
  const ENUM_STABLE = Number(process.env.PANINI_ENUM_STABLE || 8);
  const ENUM_MAX_ITERS = Number(process.env.PANINI_ENUM_MAX_ITERS || 200);
  const ENUM_BUDGET_MS = full ? Number(process.env.PANINI_ENUM_BUDGET_MIN || 10) * 60000 : DISCOVERY_BUDGET_MS;
  const tEnum = Date.now();
  let last = -1, stable = 0, enumIters = 0, enumBudgetHit = false;
  for (let i = 0; i < ENUM_MAX_ITERS && stable < ENUM_STABLE; i++) {
    if (Date.now() - tEnum > ENUM_BUDGET_MS) { enumBudgetHit = true; break; }
    enumIters++;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    domAdded += await harvestDomPskus(); // (b) merge DOM-visible pskus before the stability check
    const st = stepStability({ last, stable }, enumProgress(enumPskus.size, gridSeen));
    last = st.last; stable = st.stable;
  }
  domAdded += await harvestDomPskus(); // final sweep for the last-rendered rows
  await harvestPackLinks();
  const enumStop = enumStopReason({ budgetHit: enumBudgetHit, stable, stableThreshold: ENUM_STABLE });
  sportStats.push({
    sport, full, enum_stop: enumStop, enum_iters: enumIters, enum_ms: Date.now() - tEnum,
    grid_pages: gridPages - gridPages0, grid_items: gridSeen - gridSeen0, walked_pskus_added: enumPskus.size - enum0,
    set_ids: [...new Set([...sightings.keys()].filter((k) => k.endsWith(`|${sport}`)).map((k) => Number(k.split("|")[0])))].sort((a, b) => a - b),
  });
  console.log(`[panini-runner][diag] sport=${sport} (${full ? "full" : "discovery"}) enum_stop=${enumStop} grid_pages=${gridPages - gridPages0} grid_items=${gridSeen - gridSeen0} walked_pskus+=${enumPskus.size - enum0} set_ids=[${sportStats.at(-1).set_ids.join(",")}]`);
  }
  currentSport = null;
  // Registry sightings: one row per setId, attributed to the sport whose grid served it most.
  const bestBySet = new Map();
  for (const [k, n] of sightings) {
    const [sid, sp] = k.split("|");
    const prev = bestBySet.get(sid);
    if (!prev || n > prev.grid_items) bestBySet.set(sid, { set_id: Number(sid), sport: sp, grid_items: n, sample: sampleBySet.get(Number(sid)) ?? null });
  }
  const productSightings = [...bestBySet.values()];
  // The first sport pass is the historical Soccer walk; its figures keep the legacy field names below.
  const s0 = sportStats[0] || { enum_stop: "none", enum_iters: 0, enum_ms: 0 };
  const enumStop = s0.enum_stop, enumIters = s0.enum_iters;
  const tEnum = Date.now() - s0.enum_ms;
  // wc_share closes the one question the 2026-08-15 filing could not measure: what fraction of the
  // grid AT DEPTH is WC-Prizm. A static scan of page 1 read 48%; if the walk-wide share is far
  // lower, scoping the grid to the cardset (rather than scrolling the mixed grid) is the next fix.
  const wcShare = gridSeen ? ((enumPskus.size / gridSeen) * 100).toFixed(1) : null;
  const enumStats = {
    enum_stop: enumStop, enum_iters: enumIters, enum_ms: Date.now() - tEnum,
    grid_pages: gridPages, grid_items: gridSeen, wc_pskus: enumPskus.size,
    wc_share_pct: wcShare === null ? null : Number(wcShare), dom_added: domAdded,
  };
  console.log(`[panini-runner][diag] enum_stop=${enumStop} iters=${enumIters} grid_pages=${gridPages} grid_items=${gridSeen} wc_pskus=${enumPskus.size} wc_share=${wcShare ?? "-"}% in ${Math.round((Date.now()-tEnum)/1000)}s`);
  // diagnostics: what did the grid actually return?
  let domCards = -1, curUrl = "?";
  try { curUrl = page.url(); domCards = await page.evaluate(() => document.querySelectorAll('img[src*="packcard-"]').length); } catch {}
  console.log(`[panini-runner][diag] onepanini_responses=${opCount} data_keys_seen=[${[...dataKeys].join(",")}] grid_url=${curUrl} dom_packcard_imgs=${domCards} dom_pskus_harvested=${domAdded}`);
  if (opCount === 0) console.log("[panini-runner][diag] ZERO onepanini responses — likely not logged in OR the automated browser is being challenged (Cloudflare). Confirm the window showed real cards before you pressed ENTER.");
  const fileList = loadPskus();
  // WALK ORDER — rewritten 2026-09-19. The old code shuffled the ENUMERATED set and walked that.
  // Two separate defects, measured live, and the merge below fixes both:
  //
  //   (a) THE ENUMERATION CEILING. The grid scroll surfaces only a slice of the catalogue per run
  //       — 163 to 1,109 WC pskus across the ten walks to 2026-09-19, against 5,071 editions we
  //       already know about, stopping on `stable` (the scroll ran out of NEW cards) or `budget`.
  //       Discovery is what the grid is FOR; it was also, wrongly, the only source of refresh
  //       targets, so an edition the grid stopped surfacing could never be re-priced again.
  //   (b) THE SHUFFLE TAIL. Shuffling that slice made each walk an independent uniform sample, so
  //       the editions that kept losing the draw kept losing it: 1,265 of 5,071 (24.9%) had not
  //       been walked in 45+ days while the pipeline logged 2,103 runs and 0 failures.
  //
  // A psku is a RECORDED identifier, not a constructed one (we store it as panini_editions.
  // external_id), and the per-card walk below navigates straight to /marketplace-details/<psku>
  // — it never needed the grid to have surfaced that card in this run. So: the grid keeps
  // discovery, our own catalogue supplies refresh, oldest first.
  const discovered = enumPskus.size > 0 ? [...enumPskus] : fileList;
  let pskus, orderMode;
  if (known.length > 0) {
    const knownSet = new Set(known);
    // ⚠ "Absent from `known`" means BRAND NEW only when `known` is the COMPLETE catalogue.
    // On a partial list (a paging failure server-side) every recently-walked edition is also
    // absent, and promoting those to the front is precisely the re-walking this change exists
    // to stop — so the promotion is gated on the route saying the list is complete.
    const fresh = knownComplete ? discovered.filter((p) => !knownSet.has(p)) : [];
    const seen = new Set(fresh);
    pskus = [...fresh];
    for (const p of [...known, ...discovered]) if (!seen.has(p)) { seen.add(p); pskus.push(p); }
    orderMode = knownComplete
      ? `stalest-first (${fresh.length} new + ${known.length} known)`
      : `stalest-first, PARTIAL list (${known.length} known; new-first promotion disabled)`;
  } else {
    // FALLBACK ONLY — the order endpoint was unreachable. Shuffle (Fisher-Yates) so successive
    // runs at least cover different subsets, which is the behaviour this file had before.
    pskus = [...discovered];
    for (let i = pskus.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pskus[i], pskus[j]] = [pskus[j], pskus[i]]; }
    orderMode = "shuffled (walk-order endpoint unavailable)";
  }
  console.log(`[panini-runner] walk order = ${orderMode}; ${pskus.length} pskus queued`);
  console.log(`[panini-runner] enumerated ${enumPskus.size} WC-Prizm pskus (${domAdded} via DOM img fallback; file fallback had ${fileList.length}); walking ${pskus.length}`);
  // Post the enumeration record BEFORE the long per-card walk, so it lands even if the walk is
  // later killed (laptop sleep / unplug / rate-limit). Fire-and-forget semantics: post() already
  // swallows its own failures, and telemetry must never break the ingest it measures.
  await post({ enum: { ...enumStats, walking: pskus.length, file_fallback: fileList.length, order_mode: orderMode, known_order: known.length, known_complete: knownComplete, walk_set_ids: [...WALK_SETS], sports: sportStats, products_seen: productSightings.length, pack_links_harvested: harvestedPackUrls.size, packish_unmatched: [...packishUnmatched] } });
  // Registry upkeep: every product the grids served + every pack link found. Never admits a
  // product or disables a page — the route only records sightings and new pages.
  await post({ products: productSightings, pack_pages: [...harvestedPackUrls].map((url) => ({ url, discovered: true })) });

  // --- 2. PACKS --- (post IMMEDIATELY after this walk so pack data lands even if the long
  //     per-card walk below stalls; 2.5s wait gives getPackMarketStats time to fire on load)
  //     MULTI-PRODUCT (2026-09-28): the page list is the registry's (panini_pack_pages) plus this
  //     walk's harvested links; subpack pages first, so a product that has one keeps its numeric id
  //     (the route also maps a repeat pack_sku onto the existing row). Each visit is reported back
  //     as walked/captured — a page type that never fires getPackMarketStats shows up as
  //     last_walked_at without last_captured_at, instead of as a pack that silently never updates.
  const packUrlList = [...new Set([...(SERVED_PACK_URLS ?? PACK_URLS), ...harvestedPackUrls])]
    .sort((a, b) => Number(b.includes("/subpack-")) - Number(a.includes("/subpack-")));
  const PACK_PAGES_MAX = Number(process.env.PANINI_PACK_PAGES_MAX || 40);
  const packVisits = [];
  for (const url of packUrlList.slice(0, PACK_PAGES_MAX)) {
    currentPackId = (url.match(/subpack-\d+-(\d+)\.html$/) || [])[1] || null;
    currentPackUrl = url;
    const before = packs.length;
    packVisitOps = {}; packVisitPackLike = null;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const got = packs.slice(before);
    packVisits.push({ url, walked: true, captured: got.length > 0, pack_id: got.length ? String(got[0].__pack_id ?? got[0].pack_sku ?? "") || null : null, ops: packVisitOps, pack_like: packVisitPackLike });
    packVisitOps = null;
  }
  currentPackId = null; currentPackUrl = null;
  console.log(`[panini-runner] pack pages: ${packVisits.length} visited (${packUrlList.length} known), ${packVisits.filter((v) => v.captured).length} captured`);
  if (packs.length || packVisits.length) { console.log(`[panini-runner] posting ${packs.length} pack(s) up front`); await post({ packs, pack_pages: packVisits }); packs = []; }

  // --- 3. Per-card detail (getCardMarketStats + getPskuTotalCardsList serials) ---
  // Walk pacing: wait for THIS psku's /onepanini payload to actually arrive rather than for
  // "networkidle". The marketplace SPA polls in the background, so networkidle frequently never
  // settles and each page burned up to its 45s timeout — that is why long walks stalled before
  // finishing. domcontentloaded + a data-arrival wait cuts a typical page to ~1-2s.
  // 50 -> 75 min (2026-09-23): serial paging (loadAllSerialPages) adds ~6,900 page loads per full
  // catalogue rotation (~2 s each, ~27% more time per card). Ticks are 4 h apart and enumeration
  // takes <=10 min, so a 75 min walk (+ the observed <=10 min last-batch overrun) ends ~95 min in.
  const WALK_BUDGET_MS = Number(process.env.PANINI_WALK_BUDGET_MIN || 75) * 60000;
  const tWalk = Date.now();
  let walked = 0, captured = 0, missed = 0;
  for (const psku of pskus) {
    if (Date.now() - tWalk > WALK_BUDGET_MS) {
      console.log(`[panini-runner] walk budget hit (${Math.round((Date.now()-tWalk)/60000)}m) — stopping cleanly at ${walked}/${pskus.length}; the un-walked tail is the STALEST, so the next run resumes there`);
      break;
    }
    const before = cards.length + serials.length;
    let got = false;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      try {
        await page.goto(`${BASE}/marketplace-details/${psku}.html`, { waitUntil: "domcontentloaded", timeout: 20000 });
      } catch { /* transient nav failure — one retry below */ }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline && cards.length + serials.length === before) await page.waitForTimeout(150);
      got = cards.length + serials.length > before;
      // getCardMarketStats and getPskuTotalCardsList land separately; give the sibling call a moment
      // so we don't navigate away with only half this psku's data.
      if (got) await page.waitForTimeout(800);
    }
    // Serial pages 2..N first (the SALES HISTORY click may swap the panel), then realized sales —
    // both only worth doing on a page that actually rendered this card's data.
    if (got) await loadAllSerialPages();
    if (got) {
      if (await openSalesHistory()) { salesPages++; (await openRecentSales()) ? recentPages++ : recentMissed++; }
      else salesTabMissed++;
    }
    walked++; got ? captured++ : missed++;
    if (walked % 50 === 0) console.log(`[panini-runner] progress ${walked}/${pskus.length} captured=${captured} missed=${missed} sales_pages=${salesPages} sales_records=${salesRecords} ${Math.round((Date.now()-tWalk)/60000)}m`);
    if (cards.length + serials.length + sales.length >= BATCH) { await post({ cards, serials, sales }); cards = []; serials = []; sales = []; }
  }
  console.log(`[panini-runner] walk done ${walked}/${pskus.length} captured=${captured} missed=${missed} in ${Math.round((Date.now()-tWalk)/60000)}m`);
  // Sales coverage is reported as its own line because it is the ONE thing about this change that
  // could not be verified offline: if sales_pages is 0 while walked is large, the SALES HISTORY
  // locator ladder never matched and the tab label needs re-reading — not a data finding.
  console.log(`[panini-runner] recent sales: opened=${recentPages} missed=${recentMissed}${SALES_RECENT ? "" : " (DISABLED via PANINI_SALES_RECENT=0)"}`);
  console.log(`[panini-runner] serial paging: cards_paged=${serialPagedCards} extra_pages=${serialExtraPages} stops=${JSON.stringify(serialStops)}${SERIAL_PAGES_MAX > 0 ? "" : " (DISABLED via PANINI_SERIAL_PAGES=0)"}`);
  console.log(`[panini-runner] sales capture: tab_opened=${salesPages} tab_missed=${salesTabMissed} records=${salesRecords} top=${salesByList.top} recent=${salesByList.recent} untagged=${salesByList.untagged}${SALES_HISTORY ? "" : " (DISABLED via PANINI_SALES_HISTORY=0)"}`);
  await post({ cards, packs, serials, sales });
  if (CDP) { await browser.close().catch(() => {}); } // disconnects; leaves your Chrome open
  else { await ctx.close(); }
}

main().catch((e) => { console.error("[panini-runner] fatal:", e); process.exit(1); });
