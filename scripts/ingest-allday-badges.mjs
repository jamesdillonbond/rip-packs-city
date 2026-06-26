#!/usr/bin/env node
/**
 * scripts/ingest-allday-badges.mjs
 *
 * NFL All Day per-moment badge ingest — the Atlas-fetching half. Runs on a
 * residential-IP machine (Windows Task Scheduler), NOT Vercel: the Dapper Atlas
 * API 403-blocks Node/undici `fetch` AND datacenter egress (Vercel + GitHub
 * runners), so this shells out to `curl` for every Atlas call. All DB I/O goes
 * through the Vercel route /api/cron/allday-badge-ingest (Bearer
 * INGEST_SECRET_TOKEN) so the service-role key never leaves Vercel.
 *
 * Source: POST atlas.v1.EditionService/SearchEditions { product:"nfl" } returns
 * every NFL edition with a top-level `badges:[{slug,slugV2,title,visible,...}]`
 * array + real circulation (numOwned/numListed/numBurned/numLocked/...). Atlas
 * `id` == editions.external_id for AllDay (verified 1:1), so badges key straight
 * on external_id. Paged by offset (limit 100; pagination.totalCount ~5,835).
 *
 * Per sweep:
 *   1. curl SearchEditions page-by-page (offset 0 .. totalCount).
 *   2. For each edition, take the visible badges + circulation/market fields.
 *   3. Chunk-POST the rows to the route (it builds the badge_editions row).
 *   4. Final POST { final:true, ok, stats } -> log pipeline_runs.
 *
 * Env:
 *   INGEST_SECRET_TOKEN  (required) — Bearer for the route
 *   BASE_URL             (default https://www.rippackscity.com)
 *   MAX_PAGES            (optional) — cap pages (smoke testing); default all
 *   DRY_RUN=1            — fetch Atlas + report, but do not POST rows
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

const BASE_URL = (process.env.BASE_URL || "https://www.rippackscity.com").replace(/\/$/, "");
const TOKEN = process.env.INGEST_SECRET_TOKEN;
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : Infinity;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!TOKEN) {
  console.error("[allday-badges] missing INGEST_SECRET_TOKEN");
  process.exit(1);
}

const ROUTE = `${BASE_URL}/api/cron/allday-badge-ingest`;
const ATLAS_URL =
  "https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions";
const ATLAS_HEADERS = {
  "connect-protocol-version": "1",
  "content-type": "application/json",
  Origin: "https://dapper.market",
  Referer: "https://dapper.market/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
const PAGE_LIMIT = 100;
const ATLAS_DELAY_MS = 400; // gentle: Atlas soft-throttles rapid bursts
const UPSERT_CHUNK = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cents = (v) => (v != null && v !== "" ? Number(v) / 100 : null);
const int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── our Vercel route (plain fetch; not WAF-blocked) ──────────────────────────
async function postRoute(payload) {
  const res = await fetch(ROUTE, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Atlas via curl (undici/datacenter egress is WAF-blocked) ─────────────────
async function atlasPage(offset) {
  const body = JSON.stringify({ product: "nfl", limit: String(PAGE_LIMIT), offset: String(offset) });
  const args = ["-s", "-X", "POST", ATLAS_URL];
  for (const [k, v] of Object.entries(ATLAS_HEADERS)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", body);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await execFileP("curl", args, { maxBuffer: 32 * 1024 * 1024 });
      const t = stdout.trimStart();
      if (t.startsWith("{")) {
        const j = JSON.parse(stdout);
        if (Array.isArray(j.editions)) return j;
        // a Connect error object ({code,message}) — surface it
        lastErr = new Error(`atlas error: ${stdout.slice(0, 120)}`);
      } else {
        lastErr = new Error(`non-JSON (WAF block/throttle): ${stdout.slice(0, 80)}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1)); // backoff on block/throttle/network
  }
  throw new Error(`Atlas offset ${offset} failed: ${lastErr}`);
}

function buildRow(e) {
  const m = e.editionTemplate?.metadata ?? {};
  const player =
    [m.playerFirstName, m.playerLastName].filter(Boolean).join(" ").trim() || null;
  const badges = (e.badges ?? [])
    .filter((b) => b && b.visible !== false && b.slug && b.title)
    .map((b) => ({ slug: String(b.slug), title: String(b.title) }));
  const seriesNum = Number(e.seriesId);
  return {
    external_id: String(e.id),
    player_name: player,
    set_name: e.set?.name ?? null,
    tier: e.tier ?? null,
    parallel_name: e.parallel ?? null,
    series_number: Number.isFinite(seriesNum) ? seriesNum : null,
    parallel_id: 0,
    badges,
    has_rookie_mint: badges.some((b) => b.slug === "rookie-mint"),
    circulation_count: int(e.numMinted ?? e.maxMintSize),
    burned: int(e.numBurned),
    locked: int(e.numLocked),
    owned: int(e.numOwned),
    hidden_in_packs: int(e.numHiddenInPacks),
    low_ask: cents(e.lowAskCents),
    highest_offer: cents(e.highestOfferCents),
    avg_sale_price: cents(e.averageSalePriceCents),
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[allday-badges] start dryRun=${DRY_RUN} base=${BASE_URL}`);

  const stats = {
    editions_fetched: 0,
    editions_skipped: 0,
    with_badges: 0,
    rows_upserted: 0,
    pages: 0,
    atlas_calls: 0,
    total_count: null,
  };
  let buffer = [];

  async function flush() {
    if (!buffer.length || DRY_RUN) {
      buffer = [];
      return;
    }
    const r = await postRoute({ rows: buffer });
    stats.rows_upserted += r.upserted || 0;
    buffer = [];
  }

  let offset = 0;
  let page = 0;
  let hasMore = true;
  let fatal = null;
  while (hasMore && page < MAX_PAGES) {
    let j;
    try {
      j = await atlasPage(offset);
      stats.atlas_calls++;
    } catch (e) {
      fatal = String(e);
      console.error(`[allday-badges] ${fatal}`);
      break;
    }
    const eds = j.editions ?? [];
    stats.total_count = j.pagination?.totalCount ?? stats.total_count;
    stats.pages++;
    for (const e of eds) {
      if (e?.id == null) { stats.editions_skipped++; continue; }
      const row = buildRow(e);
      if (row.badges.length) stats.with_badges++;
      buffer.push(row);
      stats.editions_fetched++;
    }
    if (buffer.length >= UPSERT_CHUNK) await flush();

    hasMore = j.pagination?.hasMore === true && eds.length > 0;
    offset += PAGE_LIMIT;
    page++;
    if (page % 10 === 0 || !hasMore) {
      console.log(
        `[allday-badges] page ${page} off=${offset} | fetched=${stats.editions_fetched}/${stats.total_count ?? "?"} withBadges=${stats.with_badges} upserted=${stats.rows_upserted}`
      );
    }
    await sleep(ATLAS_DELAY_MS);
  }

  await flush();

  // Egress guard: if the FIRST page already failed (Atlas WAF-blocked this
  // egress — datacenter IPs are blocked even via curl), log a failure.
  const egressBlocked = fatal != null && stats.editions_fetched === 0;

  if (!DRY_RUN) {
    await postRoute({
      final: true,
      startedAt,
      ok: !fatal,
      error: egressBlocked ? "egress_blocked" : fatal,
      stats,
    });
  }

  console.log(`[allday-badges] DONE ${JSON.stringify(stats)}`);
  if (fatal) process.exit(1);
}

main().catch((e) => {
  console.error("[allday-badges] FATAL", e);
  process.exit(1);
});
