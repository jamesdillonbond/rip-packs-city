#!/usr/bin/env node
/**
 * scripts/ingest-topshot-active-listings.mjs
 *
 * Underpriced #1s deal-board ingest — the Atlas-fetching half. Runs on a GitHub
 * Actions runner (NOT Vercel): the public Dapper Atlas API 403-blocks Node/undici
 * `fetch` (and Vercel egress) but allows curl, so this shells out to curl for
 * every Atlas call. All DB I/O goes through the Vercel route
 * /api/cron/topshot-active-listings-ingest (Bearer INGEST_SECRET_TOKEN) so the
 * service-role key never leaves Vercel.
 *
 * Per sweep:
 *   1. GET targets (board candidates with an Atlas editionId) from the route.
 *   2. For each target, curl Atlas SearchMarketplaceTransactions(completed:false)
 *      twice — SERIAL_NUMBER ASC limit 1 (the #1 end) and DESC limit 1 (the
 *      perfect end). Accept a boundary row ONLY if its serialNumber equals the
 *      target (1 / circulation_count); otherwise that special serial isn't listed.
 *   3. POST the matched #1/perfect rows to the route (chunked upsert).
 *   4. Final POST { deactivate:true } -> drop listings not re-seen in 6h + log.
 *
 * 2026-09-19 — ATLAS_FETCH_MODE=browser. Cloudflare bot management on Atlas began
 * answering curl with a JavaScript challenge (`403` + "Just a moment...") from BOTH the
 * GitHub runner and Trevor's residential IP that night (known-issues #125): both arms
 * went silent while the GHA arm stayed green on its skip path. A real browser on the
 * same residential IP, with a dapper.market page open, got `200` in 709 ms (measured
 * 2026-09-19 14:1x PT). So this script can now make its Atlas calls from INSIDE a
 * browser page via Playwright: the page sits on https://dapper.market and each call is
 * a same-site `fetch` evaluated in that page, so Cloudflare sees a browser fingerprint
 * with a solved challenge, not curl. The curl path is untouched and remains the default.
 *
 * Env:
 *   INGEST_SECRET_TOKEN   (required) — Bearer for the route
 *   ATLAS_FETCH_MODE      curl (default) | browser — see above. `browser` needs the
 *                         `playwright` package (already a devDependency) and a Chromium:
 *                         either `npx playwright install chromium`, or set
 *                         ATLAS_BROWSER_CHANNEL=chrome to use the machine's own Chrome.
 *   ATLAS_BROWSER_CHANNEL (optional) — Playwright `channel` (e.g. chrome, msedge).
 *   ATLAS_BROWSER_HEADLESS (default 1) — set 0 to show the window; Cloudflare's
 *                         challenge is likelier to pass headful. The first run's log
 *                         (`atlas_mode`, `atlas_calls`, `targets_skipped`) is the
 *                         falsifier: if every target is skipped with `challenge`,
 *                         headless was detected — retry with ATLAS_BROWSER_HEADLESS=0.
 *   BASE_URL              (default https://www.rippackscity.com)
 *   FLOOR                 (default 100) — min #1 estimate $ to be a target
 *   MAX_TARGETS           (optional) — cap targets processed (smoke testing)
 *   DRY_RUN=1             — fetch Atlas + report, but do not upsert/deactivate
 *   DEADLINE_MS           (default 24min) — internal wall-clock budget. If a slow
 *                         or throttling Atlas pushes the sweep past this, the loop
 *                         stops early, flushes the partial rows, and logs a degraded
 *                         run (ok:false, NO deactivate) instead of running into the
 *                         GitHub-Actions 30-min job timeout, which SIGKILLs the
 *                         process mid-sweep — losing all buffered rows AND writing
 *                         no pipeline_runs row (a silent stall). Keep it under the
 *                         workflow's timeout-minutes.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { pathToFileURL } from "url";

const execFileP = promisify(execFile);

const BASE_URL = (process.env.BASE_URL || "https://www.rippackscity.com").replace(/\/$/, "");
const TOKEN = process.env.INGEST_SECRET_TOKEN;
const FLOOR = process.env.FLOOR != null && process.env.FLOOR !== "" ? Number(process.env.FLOOR) : 100;
const MAX_TARGETS = process.env.MAX_TARGETS ? Number(process.env.MAX_TARGETS) : Infinity;
// TARGET_OFFSET / CHUNK_MODE let an operator run one sweep as several bounded
// invocations (e.g. from a shell with a 3-minute cap): each chunk upserts its slice
// and posts NO final/deactivate; the operator posts `{ final:true, deactivate:true }`
// once after the last chunk, within the route's 6 h re-seen window. Default: whole list.
const TARGET_OFFSET = process.env.TARGET_OFFSET ? Number(process.env.TARGET_OFFSET) : 0;
const CHUNK_MODE = TARGET_OFFSET > 0 || process.env.CHUNK_MODE === "1";
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";


const ROUTE = `${BASE_URL}/api/cron/topshot-active-listings-ingest`;
const ATLAS_URL =
  "https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions";
const ATLAS_HEADERS = {
  "connect-protocol-version": "1",
  "content-type": "application/json",
  Origin: "https://dapper.market",
  Referer: "https://dapper.market/",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
// Optional Cloudflare-worker proxy for Atlas (workers/atlas-proxy). When
// ATLAS_PROXY_URL is set the script POSTs the SAME body to the worker with an
// X-Proxy-Secret header and the worker injects the Atlas headers + rides a
// Cloudflare egress IP (the GHA runner IP is WAF-blocked -> egress_blocked).
// Unset ⇒ direct curl to Atlas, byte-identical to the legacy behaviour, so this
// whole path is inert until the operator deploys the worker + sets these envs.
const ATLAS_PROXY_URL = (process.env.ATLAS_PROXY_URL || "").replace(/\/$/, "");
const ATLAS_PROXY_SECRET = process.env.ATLAS_PROXY_SECRET || process.env.TS_PROXY_SECRET || "";
const USE_ATLAS_PROXY = ATLAS_PROXY_URL !== "";
const ATLAS_FETCH_MODE = (process.env.ATLAS_FETCH_MODE || "curl").toLowerCase();
if (ATLAS_FETCH_MODE !== "curl" && ATLAS_FETCH_MODE !== "browser") {
  throw new Error(`ATLAS_FETCH_MODE must be curl or browser, got ${JSON.stringify(process.env.ATLAS_FETCH_MODE)}`);
}
const USE_BROWSER = ATLAS_FETCH_MODE === "browser";
const ATLAS_BROWSER_CHANNEL = process.env.ATLAS_BROWSER_CHANNEL || undefined;
const ATLAS_BROWSER_HEADLESS = process.env.ATLAS_BROWSER_HEADLESS !== "0";
const BROWSER_ORIGIN = "https://dapper.market/";
const ATLAS_DELAY_MS = 400; // gentle: Atlas soft-throttles rapid bursts
const UPSERT_CHUNK = 200;
// Internal wall-clock budget, well under the GHA job's timeout-minutes:30. When a
// slow/throttling Atlas makes the per-target retry cost balloon, we stop early and
// exit gracefully (partial upsert + degraded log) rather than getting SIGKILLed at
// the hard timeout with total, silent data loss.
const DEADLINE_MS = process.env.DEADLINE_MS ? Number(process.env.DEADLINE_MS) : 24 * 60 * 1000;
// Consecutive failures (with zero successes) that constitute proof this runner's
// egress is WAF-blocked, so the sweep can stop in ~1 min instead of ~24. Must be
// > 1: one edition can fail on its own merits, a run of them cannot.
const EGRESS_PROBE_N = process.env.EGRESS_PROBE_N ? Number(process.env.EGRESS_PROBE_N) : 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── our Vercel route (plain fetch; not WAF-blocked) ──────────────────────────
async function getTargets() {
  const res = await fetch(`${ROUTE}?phase=targets&floor=${FLOOR}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`GET targets failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.targets || [];
}

async function postRoute(payload) {
  const res = await fetch(ROUTE, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── the Atlas request, shared by every transport ─────────────────────────────
function atlasBoundaryBody(atlasEditionId, direction) {
  return JSON.stringify({
    product: "nba",
    completed: false,
    editionId: String(atlasEditionId),
    sortByOption: "SERIAL_NUMBER",
    sortByDirection: direction, // "ASC" (#1 end) | "DESC" (perfect end)
    limit: "1",
    offset: "0",
    offers: false,
  });
}

// One raw Atlas response text → the boundary transaction, or a typed failure.
// Shared by curl and browser so both transports are judged by the same rule:
//   { tx }            JSON with a transactions array (tx null = nothing listed)
//   { blocked: msg }  non-JSON — Cloudflare challenge page ("Just a moment...") or
//                     a WAF/throttle body; the caller retries with backoff.
function parseAtlasBoundary(text, status) {
  const t = (text ?? "").trimStart();
  if (status != null && status !== 200) {
    const kind = /Just a moment|cf-chl|challenge/i.test(t) ? "challenge" : "http";
    return { blocked: `${kind} ${status}: ${t.slice(0, 80)}` };
  }
  if (t.startsWith("{")) {
    const j = JSON.parse(t);
    return { tx: Array.isArray(j.transactions) ? j.transactions[0] ?? null : null };
  }
  const kind = /Just a moment|cf-chl/i.test(t) ? "challenge" : "non-JSON (WAF block/throttle)";
  return { blocked: `${kind}: ${t.slice(0, 80)}` };
}

// ── Atlas via a real browser page (Cloudflare-challenged curl, 2026-09-19) ──────
// A single Playwright context, opened lazily on the first call and closed by
// main(). The page is parked on dapper.market so the fetch is same-site and
// carries whatever clearance the challenge granted the browser. Each call is a
// `page.evaluate` of a plain fetch; the page returns status + body text and the
// caller parses it with the SAME rule as the curl path.
let browserState = null;
async function browserPage() {
  if (browserState) return browserState.page;
  const { chromium } = await import("playwright");
  // ⚠ MEASURED 2026-09-19 (laptop VM, residential IP), and every clause below is
  // load-bearing: Playwright's default headless shell announces `HeadlessChrome`
  // and `--enable-automation`, and Cloudflare challenged the LANDING page itself
  // (403, "Just a moment...", never cleared) — so did the full Chromium with the
  // same defaults. The same full Chromium launched WITHOUT `--enable-automation`,
  // with `--disable-blink-features=AutomationControlled`, and a desktop Chrome
  // UA/locale/timezone/viewport got the landing page 200 and the in-page API fetch
  // 200 on the first try. Playwright's Node-side `request` context still got 403
  // with the same cookies — only the IN-PAGE fetch carries the clearance, which is
  // why this transport evaluates fetch inside the page rather than replaying cookies.
  // `channel: "chromium"` selects the full browser (new headless) over the shell.
  const launchOpts = {
    headless: ATLAS_BROWSER_HEADLESS,
    channel: ATLAS_BROWSER_CHANNEL ?? "chromium",
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1366, height: 768 },
  });
  const page = await context.newPage();
  // A challenge, if Cloudflare issues one on the landing page, is solved here
  // once, before any API call; the API calls then ride the same cookies.
  const landing = await page.goto(BROWSER_ORIGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(3000);
  const title = await page.title();
  browserState = { browser, page };
  if ((landing && landing.status() !== 200) || /just a moment/i.test(title)) {
    // Say so ONCE, loudly, with the mechanism — the per-target loop would otherwise
    // report it as N identical "challenge" skips and the egress probe would stop the
    // sweep as "egress_blocked", which is true but names the wrong layer.
    console.error(
      `[listings-ingest] browser transport: dapper.market landing was challenged (status ${landing?.status()}, title ${JSON.stringify(title)}) — headless detected; retry with ATLAS_BROWSER_HEADLESS=0 or ATLAS_BROWSER_CHANNEL=chrome`
    );
  }
  console.log(
    `[listings-ingest] atlas transport: browser (${ATLAS_BROWSER_CHANNEL ?? "chromium"}, headless=${ATLAS_BROWSER_HEADLESS}, landing ${landing?.status()} ${JSON.stringify(title).slice(0, 40)})`
  );
  return page;
}
async function closeBrowser() {
  if (!browserState) return;
  try {
    await browserState.browser.close();
  } catch {
    /* closing is best-effort */
  }
  browserState = null;
}
async function atlasViaBrowser(body) {
  const page = await browserPage();
  return page.evaluate(
    async ({ url, body }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "connect-protocol-version": "1", "content-type": "application/json" },
          body,
          signal: ctrl.signal,
        });
        return { status: r.status, text: await r.text() };
      } finally {
        clearTimeout(t);
      }
    },
    { url: ATLAS_URL, body }
  );
}

// ── Atlas boundary: curl (default) or browser ────────────────────────────────
async function atlasBoundary(atlasEditionId, direction) {
  const body = atlasBoundaryBody(atlasEditionId, direction);
  if (USE_BROWSER) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { status, text } = await atlasViaBrowser(body);
        const parsed = parseAtlasBoundary(text, status);
        if ("tx" in parsed) return parsed.tx;
        lastErr = new Error(parsed.blocked);
      } catch (e) {
        lastErr = e;
      }
      await sleep(1500 * (attempt + 1));
    }
    throw new Error(`Atlas ${direction} edition ${atlasEditionId} failed (browser): ${lastErr}`);
  }
  // --connect-timeout/--max-time bound every call. Without them a throttling Atlas
  // that accepts the connection but never responds would hang curl indefinitely —
  // the retry backoff only bounds FAILED calls, and the main loop's DEADLINE_MS
  // check runs between iterations, so a single hung call would otherwise ride all
  // the way to the GHA 30-min job timeout (the silent-SIGKILL this script guards).
  const url = USE_ATLAS_PROXY ? ATLAS_PROXY_URL : ATLAS_URL;
  const args = ["-s", "--connect-timeout", "10", "--max-time", "30", "-X", "POST", url];
  if (USE_ATLAS_PROXY) {
    // The worker injects the Atlas headers; the caller only sends the body + secret.
    args.push("-H", "content-type: application/json", "-H", `X-Proxy-Secret: ${ATLAS_PROXY_SECRET}`);
  } else {
    for (const [k, v] of Object.entries(ATLAS_HEADERS)) args.push("-H", `${k}: ${v}`);
  }
  args.push("--data-binary", body);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await execFileP("curl", args, { maxBuffer: 8 * 1024 * 1024 });
      const parsed = parseAtlasBoundary(stdout, null);
      if ("tx" in parsed) return parsed.tx;
      lastErr = new Error(parsed.blocked);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1)); // backoff on block/throttle/network
  }
  throw new Error(`Atlas ${direction} edition ${atlasEditionId} failed: ${lastErr}`);
}

// The target table's primary key is (edition_id, serial_number). A 1-of-1 edition's
// "#1" boundary and its "perfect" boundary are the SAME listing, so the sweep buffers
// two rows with one key and Postgres rejects the whole chunk: "ON CONFLICT DO UPDATE
// command cannot affect row a second time" (hit 2026-09-19 on edition 15601,
// circulation 1 — and it would have killed a 200-row chunk on the curl path too).
// Keep the FIRST row for a key: the #1 pick, whose serial_fmv_usd is the #1 estimate.
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.edition_id}\u0000${r.serial_number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function buildRow(target, tx, isNo1) {
  const nftId = tx.nftId != null ? String(tx.nftId) : null;
  return {
    edition_id: target.rpc_edition_id,
    edition_key: target.external_id,
    serial_number: Number(tx.serialNumber),
    nft_id: nftId,
    ask_usd: tx.priceCents != null ? Number(tx.priceCents) / 100 : null,
    serial_fmv_usd: (isNo1 ? target.no1_estimate_usd : target.perfect_estimate_usd) ?? null,
    listing_resource_id: tx.uuid ?? null,
    // dapper.market keys its per-serial detail page by the on-chain moment id, so
    // the confirmed deep-link is /nba/moment/<nftId> (this ingest is NBA Top Shot
    // only — product:"nba"). Same URL the boards derive as a fallback from nft_id
    // (lib/underpriced-serials-board.ts, lib/collections.ts dapperMarketMomentUrl);
    // persisting it here means the row carries the real listing link, not null.
    listing_url: nftId ? `https://dapper.market/nba/moment/${encodeURIComponent(nftId)}` : null,
    listed_at: tx.listedAt ?? null,
  };
}

async function main() {
  // Moved here from module scope 2026-08-16 so this file can be imported by a test without
  // the import itself calling process.exit. Direct-run behaviour is unchanged and verified
  // byte-for-byte: same stderr line, same exit code 1, and it still happens before any
  // network call.
  if (!TOKEN) {
    console.error("[listings-ingest] missing INGEST_SECRET_TOKEN");
    process.exit(1);
  }
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let timedOut = false;
  console.log(`[listings-ingest] start floor=$${FLOOR} dryRun=${DRY_RUN} base=${BASE_URL} deadlineMs=${DEADLINE_MS}`);

  const allTargets = await getTargets();
  const targets = allTargets.slice(
    TARGET_OFFSET,
    MAX_TARGETS === Infinity ? allTargets.length : TARGET_OFFSET + MAX_TARGETS
  );
  console.log(
    `[listings-ingest] ${allTargets.length} targets; processing ${targets.length}` +
      (CHUNK_MODE ? ` (chunk: offset ${TARGET_OFFSET}, no final/deactivate)` : "")
  );

  const stats = {
    atlas_mode: ATLAS_FETCH_MODE,
    targets_processed: 0,
    targets_skipped: 0,
    no1_found: 0,
    perfect_found: 0,
    listings_found: 0,
    rows_upserted: 0,
    atlas_calls: 0,
  };
  let buffer = [];

  async function flush() {
    if (!buffer.length) return;
    if (DRY_RUN) {
      buffer = [];
      return;
    }
    const r = await postRoute({ rows: dedupeRows(buffer) });
    stats.rows_upserted += r.upserted || 0;
    buffer = [];
  }

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - t0 > DEADLINE_MS) {
      timedOut = true;
      console.warn(
        `[listings-ingest] deadline hit (${Math.round((Date.now() - t0) / 1000)}s) after ${i}/${targets.length} targets — stopping early`
      );
      break;
    }
    // Fail-fast egress probe. When Atlas WAF-blocks this runner EVERY target
    // fails, but the `allBlocked` verdict below only lands after the whole
    // ~1,080-target sweep — and each blocked target burns atlasBoundary's 4
    // attempts of backoff, so a fully-blocked run cost ~24 min (measured p95
    // 1,453,742 ms) to learn something the first few calls already proved.
    // Requiring ZERO successes across EGRESS_PROBE_N consecutive failures keeps
    // the exact semantics of `allBlocked` (processed === 0 && skipped > 0) while
    // short-circuiting in ~1 min. N > 1 so a single edition erroring for its own
    // reasons can never trigger a false "blocked" verdict.
    if (stats.targets_processed === 0 && stats.targets_skipped >= EGRESS_PROBE_N) {
      console.error(
        `[listings-ingest] egress probe: ${stats.targets_skipped} consecutive failures with 0 successes after ${Math.round((Date.now() - t0) / 1000)}s — treating as WAF block, stopping early`
      );
      break;
    }
    const t = targets[i];
    try {
      // #1 end
      const ascTx = await atlasBoundary(t.atlas_edition_id, "ASC");
      stats.atlas_calls++;
      if (ascTx && String(ascTx.serialNumber) === "1") {
        buffer.push(buildRow(t, ascTx, true));
        stats.no1_found++;
        stats.listings_found++;
      }
      await sleep(ATLAS_DELAY_MS);

      // perfect end
      const descTx = await atlasBoundary(t.atlas_edition_id, "DESC");
      stats.atlas_calls++;
      if (descTx && t.circulation_count != null && String(descTx.serialNumber) === String(t.circulation_count)) {
        buffer.push(buildRow(t, descTx, false));
        stats.perfect_found++;
        stats.listings_found++;
      }
      stats.targets_processed++;
    } catch (e) {
      stats.targets_skipped++;
      console.log(`[listings-ingest] skip ${t.external_id} (atlas ${t.atlas_edition_id}): ${String(e).slice(0, 100)}`);
    }

    if (buffer.length >= UPSERT_CHUNK) await flush();
    if ((i + 1) % 100 === 0 || i === targets.length - 1) {
      console.log(
        `[listings-ingest] ${i + 1}/${targets.length} | #1=${stats.no1_found} perfect=${stats.perfect_found} upserted=${stats.rows_upserted} atlasCalls=${stats.atlas_calls} skipped=${stats.targets_skipped}`
      );
    }
    await sleep(ATLAS_DELAY_MS);
  }

  await flush();

  // Egress guard: if EVERY target was skipped (Atlas WAF-blocked this egress —
  // datacenter IPs are blocked even via curl, confirmed 2026-06-17 on the GH
  // runner), do NOT deactivate (it would empty the board) and log a failure.
  const allBlocked = stats.targets_processed === 0 && stats.targets_skipped > 0;

  if (!DRY_RUN) {
    if (allBlocked) {
      await postRoute({ final: true, deactivate: false, startedAt, ok: false, error: "egress_blocked", floor: FLOOR, stats });
      console.error(
        `[listings-ingest] ${stats.targets_skipped}/${targets.length} targets attempted, 0 succeeded — egress WAF-blocked; skipped deactivate`
      );
      console.log(`[listings-ingest] DONE ${JSON.stringify(stats)}`);
      process.exit(1);
    }
    if (timedOut) {
      // Ran out of the internal wall-clock budget before finishing the sweep
      // (Atlas slow/throttling). Land the partial rows we DID collect, but do NOT
      // deactivate — an incomplete sweep would wrongly drop still-live listings it
      // never got to re-see. Log a degraded run so the stall/alert path sees a real
      // row instead of the silent 30-min SIGKILL that used to lose everything.
      await postRoute({ final: true, deactivate: false, startedAt, ok: false, error: "time_budget_exceeded", floor: FLOOR, stats });
      console.error(
        `[listings-ingest] TIME BUDGET EXCEEDED after ${stats.targets_processed}/${targets.length} targets (${Math.round((Date.now() - t0) / 1000)}s) — landed partial rows, skipped deactivate`
      );
      console.log(`[listings-ingest] DONE ${JSON.stringify(stats)}`);
      process.exit(0);
    }
    if (CHUNK_MODE) {
      console.log(`[listings-ingest] chunk complete — final/deactivate left to the operator`);
    } else {
      const fin = await postRoute({ final: true, deactivate: true, startedAt, ok: true, floor: FLOOR, stats });
      console.log(`[listings-ingest] deactivated stale=${fin.deactivated}`);
    }
  }

  console.log(`[listings-ingest] DONE ${JSON.stringify(stats)}`);
}

// The browser (if any) must not outlive the sweep — a Chromium left running on the
// residential machine every 3 h is the kind of leak nobody notices for a month.
async function mainAndClose() {
  try {
    await main();
  } finally {
    await closeBrowser();
  }
}

// Run only when invoked directly, so the pure helpers above can be imported by a test.
//
// ⚠ THIS GUARD IS LOAD-BEARING AND ITS FAILURE MODE IS SILENT. This script is the whole of
// the `topshot-active-listings-ingest` workflow; if the condition were wrong the job would
// exit 0 having done nothing, writing no pipeline_runs row — indistinguishable from "the
// cron never fired", which is the exact invisible-failure shape CLAUDE.md records for the
// 401'd catalog cron and the gate-key outage. It is compared as a file URL rather than a
// raw path because argv[1] is an OS path (backslashes on Windows) while import.meta.url is
// always a URL, so a string compare of the two is wrong on the maintainer's own machine.
// __tests__/scripts-ingest-topshot-active-listings.test.ts SPAWNS this file and asserts it
// still runs, rather than trusting the condition by reading it.
const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  mainAndClose().catch((e) => {
    console.error("[listings-ingest] FATAL", e);
    process.exit(1);
  });
}

export { buildRow, parseAtlasBoundary, atlasBoundaryBody, dedupeRows };
