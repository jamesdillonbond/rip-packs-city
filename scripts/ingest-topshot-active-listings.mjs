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
  const args = ["-s", "-X", "POST", ATLAS_URL];
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
  return {
    edition_id: target.rpc_edition_id,
    edition_key: target.external_id,
    serial_number: Number(tx.serialNumber),
    nft_id: tx.nftId != null ? String(tx.nftId) : null,
    ask_usd: tx.priceCents != null ? Number(tx.priceCents) / 100 : null,
    serial_fmv_usd: (isNo1 ? target.no1_estimate_usd : target.perfect_estimate_usd) ?? null,
    listing_resource_id: tx.uuid ?? null,
    // dapper.market per-serial deep-link format is undiscoverable here (the site
    // WAF-blocks curl); board drill-down uses nft_id -> internal /moment/<nft_id>.
    // TODO: set the real dapper.market listing URL once its format is confirmed.
    listing_url: null,
    listed_at: tx.listedAt ?? null,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[listings-ingest] start floor=$${FLOOR} dryRun=${DRY_RUN} base=${BASE_URL}`);

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

  if (!DRY_RUN) {
    const fin = await postRoute({ deactivate: true, startedAt, ok: true, floor: FLOOR, stats });
    console.log(`[listings-ingest] deactivated stale=${fin.deactivated}`);
  }

  console.log(`[listings-ingest] DONE ${JSON.stringify(stats)}`);
}

main().catch((e) => {
  console.error("[listings-ingest] FATAL", e);
  process.exit(1);
});
