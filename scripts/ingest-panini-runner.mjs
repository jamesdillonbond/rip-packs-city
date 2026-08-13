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
  const n = (payload.cards?.length || 0) + (payload.packs?.length || 0) + (payload.serials?.length || 0) + (payload.sales?.length || 0);
  if (!n) return;
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

const WC_PREFIX = "packcard-2332_"; // WC2026 Prizm World Cup Soccer setId (verified live 2026-07-16)

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
  let currentPackId = null; // set before each PACK_URLS goto so packs get their real id
  const nationByPsku = {}; // psku -> country (only the grid list carries team; per-card API does not)
  let opCount = 0; const dataKeys = new Set();
  let salesRecords = 0, salesPages = 0, salesTabMissed = 0;
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
    if (d.getCardMarketStats?.data) { const cd = d.getCardMarketStats.data; if (cd.psku && nationByPsku[cd.psku]) cd.__nation = nationByPsku[cd.psku]; cards.push(cd); }
    if (d.getPackMarketStats?.data) { const pk = d.getPackMarketStats.data; if (currentPackId) pk.__pack_id = currentPackId; packs.push(pk); }
    const prods = d.getPskuTotalCardsList?.data?.products;
    if (Array.isArray(prods)) serials.push(...prods);
    const saleRecs = []; findSaleRecords(d, 0, saleRecs);
    if (saleRecs.length) { sales.push(...saleRecs); salesRecords += saleRecs.length; }
    const items = []; findItems(d, 0, items);
    for (const it of items) if (it?.psku && String(it.psku).startsWith(WC_PREFIX)) { enumPskus.add(it.psku); if (it.team) nationByPsku[it.psku] = it.team; }
    if (DEBUG && items.length) console.log(`[panini-runner][debug] onepanini keys=${Object.keys(d).join(",")} items=${items.length} wc=${[...enumPskus].length}`);
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
      if (psku.startsWith(WC_PREFIX) && !enumPskus.has(psku)) { enumPskus.add(psku); added++; }
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

  // --- 1. ENUMERATE: walk the Soccer grid, scroll to paginate, collect WC Prizm pskus ---
  await page.goto(`${BASE}/marketplace/nfts.html?sport=Soccer`, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500);
  let last = -1, stable = 0, domAdded = 0;
  for (let i = 0; i < 80 && stable < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    domAdded += await harvestDomPskus(); // (b) merge DOM-visible pskus before the stability check
    const n = enumPskus.size;
    if (n === last) stable++; else stable = 0;
    last = n;
  }
  domAdded += await harvestDomPskus(); // final sweep for the last-rendered rows
  // diagnostics: what did the grid actually return?
  let domCards = -1, curUrl = "?";
  try { curUrl = page.url(); domCards = await page.evaluate(() => document.querySelectorAll('img[src*="packcard-"]').length); } catch {}
  console.log(`[panini-runner][diag] onepanini_responses=${opCount} data_keys_seen=[${[...dataKeys].join(",")}] grid_url=${curUrl} dom_packcard_imgs=${domCards} dom_pskus_harvested=${domAdded}`);
  if (opCount === 0) console.log("[panini-runner][diag] ZERO onepanini responses — likely not logged in OR the automated browser is being challenged (Cloudflare). Confirm the window showed real cards before you pressed ENTER.");
  const fileList = loadPskus();
  const pskus = enumPskus.size > 0 ? [...enumPskus] : fileList;
  // Shuffle the walk order (Fisher-Yates): if a run stalls partway (Chrome/laptop/rate-limit), successive
  // scheduled runs then cover DIFFERENT subsets instead of always re-walking the same first chunk, so the
  // whole set stays fresh over a few runs. Editions/serials post incrementally, so partial runs still land.
  for (let i = pskus.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pskus[i], pskus[j]] = [pskus[j], pskus[i]]; }
  console.log(`[panini-runner] enumerated ${enumPskus.size} WC-Prizm pskus (${domAdded} via DOM img fallback; file fallback had ${fileList.length}); walking ${pskus.length}`);

  // --- 2. PACKS --- (post IMMEDIATELY after this walk so pack data lands even if the long
  //     per-card walk below stalls; 2.5s wait gives getPackMarketStats time to fire on load)
  for (const url of PACK_URLS) {
    currentPackId = (url.match(/-(\d+)\.html/) || [])[1] || null;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  currentPackId = null;
  if (packs.length) { console.log(`[panini-runner] posting ${packs.length} pack(s) up front`); await post({ packs }); packs = []; }

  // --- 3. Per-card detail (getCardMarketStats + getPskuTotalCardsList serials) ---
  // Walk pacing: wait for THIS psku's /onepanini payload to actually arrive rather than for
  // "networkidle". The marketplace SPA polls in the background, so networkidle frequently never
  // settles and each page burned up to its 45s timeout — that is why long walks stalled before
  // finishing. domcontentloaded + a data-arrival wait cuts a typical page to ~1-2s.
  const WALK_BUDGET_MS = Number(process.env.PANINI_WALK_BUDGET_MIN || 50) * 60000;
  const tWalk = Date.now();
  let walked = 0, captured = 0, missed = 0;
  for (const psku of pskus) {
    if (Date.now() - tWalk > WALK_BUDGET_MS) {
      console.log(`[panini-runner] walk budget hit (${Math.round((Date.now()-tWalk)/60000)}m) — stopping cleanly at ${walked}/${pskus.length}; shuffle means the next run covers a different subset`);
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
    // Realized sales: only worth a click on a page that actually rendered this card's data.
    if (got) { (await openSalesHistory()) ? salesPages++ : salesTabMissed++; }
    walked++; got ? captured++ : missed++;
    if (walked % 50 === 0) console.log(`[panini-runner] progress ${walked}/${pskus.length} captured=${captured} missed=${missed} sales_pages=${salesPages} sales_records=${salesRecords} ${Math.round((Date.now()-tWalk)/60000)}m`);
    if (cards.length + serials.length + sales.length >= BATCH) { await post({ cards, serials, sales }); cards = []; serials = []; sales = []; }
  }
  console.log(`[panini-runner] walk done ${walked}/${pskus.length} captured=${captured} missed=${missed} in ${Math.round((Date.now()-tWalk)/60000)}m`);
  // Sales coverage is reported as its own line because it is the ONE thing about this change that
  // could not be verified offline: if sales_pages is 0 while walked is large, the SALES HISTORY
  // locator ladder never matched and the tab label needs re-reading — not a data finding.
  console.log(`[panini-runner] sales capture: tab_opened=${salesPages} tab_missed=${salesTabMissed} records=${salesRecords}${SALES_HISTORY ? "" : " (DISABLED via PANINI_SALES_HISTORY=0)"}`);
  await post({ cards, packs, serials, sales });
  if (CDP) { await browser.close().catch(() => {}); } // disconnects; leaves your Chrome open
  else { await ctx.close(); }
}

main().catch((e) => { console.error("[panini-runner] fatal:", e); process.exit(1); });
