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
 * Env:
 *   INGEST_SECRET_TOKEN   (required) — Bearer for the route
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

const execFileP = promisify(execFile);

const BASE_URL = (process.env.BASE_URL || "https://www.rippackscity.com").replace(/\/$/, "");
const TOKEN = process.env.INGEST_SECRET_TOKEN;
const FLOOR = process.env.FLOOR != null && process.env.FLOOR !== "" ? Number(process.env.FLOOR) : 100;
const MAX_TARGETS = process.env.MAX_TARGETS ? Number(process.env.MAX_TARGETS) : Infinity;
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";

if (!TOKEN) {
  console.error("[listings-ingest] missing INGEST_SECRET_TOKEN");
  process.exit(1);
}

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

// ── Atlas via curl (undici is WAF-blocked) ───────────────────────────────────
async function atlasBoundary(atlasEditionId, direction) {
  const body = JSON.stringify({
    product: "nba",
    completed: false,
    editionId: String(atlasEditionId),
    sortByOption: "SERIAL_NUMBER",
    sortByDirection: direction, // "ASC" (#1 end) | "DESC" (perfect end)
    limit: "1",
    offset: "0",
    offers: false,
  });
  // --connect-timeout/--max-time bound every call. Without them a throttling Atlas
  // that accepts the connection but never responds would hang curl indefinitely —
  // the retry backoff only bounds FAILED calls, and the main loop's DEADLINE_MS
  // check runs between iterations, so a single hung call would otherwise ride all
  // the way to the GHA 30-min job timeout (the silent-SIGKILL this script guards).
  const args = ["-s", "--connect-timeout", "10", "--max-time", "30", "-X", "POST", ATLAS_URL];
  for (const [k, v] of Object.entries(ATLAS_HEADERS)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", body);

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { stdout } = await execFileP("curl", args, { maxBuffer: 8 * 1024 * 1024 });
      const t = stdout.trimStart();
      if (t.startsWith("{")) {
        const j = JSON.parse(stdout);
        return Array.isArray(j.transactions) ? j.transactions[0] ?? null : null;
      }
      lastErr = new Error(`non-JSON (WAF block/throttle): ${stdout.slice(0, 80)}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1)); // backoff on block/throttle/network
  }
  throw new Error(`Atlas ${direction} edition ${atlasEditionId} failed: ${lastErr}`);
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
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let timedOut = false;
  console.log(`[listings-ingest] start floor=$${FLOOR} dryRun=${DRY_RUN} base=${BASE_URL} deadlineMs=${DEADLINE_MS}`);

  const allTargets = await getTargets();
  const targets = allTargets.slice(0, MAX_TARGETS === Infinity ? allTargets.length : MAX_TARGETS);
  console.log(`[listings-ingest] ${allTargets.length} targets; processing ${targets.length}`);

  const stats = {
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
    const r = await postRoute({ rows: buffer });
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
    const fin = await postRoute({ final: true, deactivate: true, startedAt, ok: true, floor: FLOOR, stats });
    console.log(`[listings-ingest] deactivated stale=${fin.deactivated}`);
  }

  console.log(`[listings-ingest] DONE ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[listings-ingest] FATAL", e);
  process.exit(1);
});
