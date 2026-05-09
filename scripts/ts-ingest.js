#!/usr/bin/env node
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy";
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN;
const TS_CONTRACT_ADDRESS = "0x0b2a3299cc857e29";
const TS_CONTRACT_NAME = "TopShot";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!FLOWTY_PROXY_TOKEN) {
  console.error("Missing FLOWTY_PROXY_TOKEN");
  process.exit(1);
}

function flattenTraits(raw) {
  // nftView.traits can be { traits: { "0": {name, value}, "1": ... } }
  // or an array, or an object with numeric keys
  if (!raw) return [];
  const inner = raw.traits ?? raw;
  if (Array.isArray(inner)) return inner;
  return Object.values(inner).filter(v => typeof v === "object" && v !== null && v.name);
}

function getTraitMulti(traits, keys) {
  for (const key of keys) {
    const t = traits.find(t => t.name === key);
    if (t?.value) return t.value;
  }
  return null;
}

const TRAIT_MAP = {
  setName:      ["SetName", "setName", "Set Name", "set_name"],
  tier:         ["Tier", "tier", "MomentTier", "momentTier"],
  seriesNumber: ["SeriesNumber", "seriesNumber", "Series Number", "series_number", "Series"],
  locked:       ["Locked", "locked"],
  setID:        ["SetID", "setID", "Set ID", "set_id"],
  playID:       ["PlayID", "playID", "Play ID", "play_id"],
};

async function fetchFlowtyPage(from) {
  const res = await fetch(FLOWTY_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: TS_CONTRACT_ADDRESS,
      contractName: TS_CONTRACT_NAME,
      payload: {
        address: null,
        addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from,
        includeAllListings: true,
        limit: 24,
        onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`flowty-proxy HTTP ${res.status} from=${from}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json?.nfts ?? json?.data ?? [];
}

async function upsert(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ts_listings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
      "Prefer": "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase upsert ${res.status}: ${t.slice(0, 300)}`);
  }
}

async function deleteStale() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ts_listings?ingested_at=lt.${cutoff}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "apikey": SUPABASE_KEY },
  });
  if (!res.ok) console.error(`Stale delete failed: ${res.status}`);
}

// Mirror the Vercel routes' pipeline_runs visibility so silent failures from
// this GH Actions workflow surface in /admin health checks instead of going
// dark for hours. Best-effort — never throws back into the run.
async function logPipelineRun(stats) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_pipeline_run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "apikey": SUPABASE_KEY,
      },
      body: JSON.stringify({
        p_pipeline: "ts-listing-ingest",
        p_started_at: stats.startedAtIso,
        p_rows_found: stats.rowsFound,
        p_rows_written: stats.rowsWritten,
        p_rows_skipped: stats.rowsSkipped,
        p_ok: stats.ok,
        p_error: stats.errorMsg,
        p_collection_slug: "nba_top_shot",
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: stats.extra,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`log_pipeline_run ${res.status}: ${t.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`log_pipeline_run threw: ${err.message}`);
  }
}

(async () => {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const stats = {
    startedAtIso,
    ok: true,
    errorMsg: null,
    rowsFound: 0,
    rowsWritten: 0,
    rowsSkipped: 0,
    extra: {
      pages_total: 0,
      pages_failed: 0,
      page_failure_reasons: [],
      total_fetched: 0,
      deduped: 0,
      resolved_ids: 0,
      duration_ms: 0,
    },
  };
  let exitCode = 0;
  try {
    const offsets = [0, 24, 48, 72, 96];
    stats.extra.pages_total = offsets.length;
    const pages = await Promise.allSettled(offsets.map(o => fetchFlowtyPage(o)));
    const all = [];
    let pageFailures = 0;
    for (const [i, result] of pages.entries()) {
      if (result.status === "fulfilled") {
        console.log(`Page from=${offsets[i]}: ${result.value.length} items`);
        all.push(...result.value);
      } else {
        pageFailures += 1;
        const reason = result.reason?.message ?? String(result.reason);
        console.error(`Page from=${offsets[i]} failed: ${reason}`);
        stats.extra.page_failure_reasons.push(`from=${offsets[i]}: ${reason.slice(0, 160)}`);
      }
    }
    stats.extra.pages_failed = pageFailures;
    if (pageFailures === offsets.length) {
      stats.ok = false;
      stats.errorMsg = `all ${offsets.length} Flowty pages failed via flowty-proxy`;
      console.error(`All ${offsets.length} Flowty pages failed via flowty-proxy — skipping deleteStale to preserve last good data`);
      exitCode = 1;
      return;
    }

    // Log first item structure for debugging
    if (all.length > 0) {
      const first = all[0];
      console.log("First item keys:", Object.keys(first).join(", "));
      const order = first.orders?.[0];
      if (order) console.log("First order keys:", Object.keys(order).join(", "), "| salePrice:", order.salePrice);
      console.log("nftView serial:", first.nftView?.serial, "card.num:", first.card?.num, "card.max:", first.card?.max);
      const firstTraits = Array.isArray(first.nftView?.traits) ? first.nftView.traits : Object.values(first.nftView?.traits ?? {});
      console.log("Trait keys:", firstTraits.map(t => t.name).join(", "));
      console.log("SetID:", getTraitMulti(firstTraits, TRAIT_MAP.setID), "PlayID:", getTraitMulti(firstTraits, TRAIT_MAP.playID));
    }

    console.log(`Total fetched: ${all.length}`);
    stats.extra.total_fetched = all.length;
    const now = new Date().toISOString();
    const rows = [];
    for (const item of all) {
      const order = item.orders?.find(o => (o.salePrice ?? 0) > 0);
      if (!order) continue;
      const serial = item.nftView?.serial ?? item.card?.num ?? 0;
      if (!serial) continue;
      const traits = flattenTraits(item.nftView?.traits);

      // Extract integer set/play IDs from Flowty NFT traits
      const rawSetId = parseInt(getTraitMulti(traits, TRAIT_MAP.setID) ?? "0", 10) || 0;
      const rawPlayId = parseInt(getTraitMulti(traits, TRAIT_MAP.playID) ?? "0", 10) || 0;

      rows.push({
        listing_id: order.listingResourceID ?? String(item.id),
        flow_id: String(item.id),
        set_id: rawSetId,
        play_id: rawPlayId,
        parallel_id: 0,
        serial_number: serial,
        circulation_count: item.card?.max ?? 0,
        price_usd: order.salePrice,
        seller_address: order.storefrontAddress ?? order.flowtyStorefrontAddress ?? null,
        player_name: item.card?.title ?? null,
        set_name: getTraitMulti(traits, TRAIT_MAP.setName) ?? null,
        moment_tier: (getTraitMulti(traits, TRAIT_MAP.tier) ?? "COMMON").toUpperCase(),
        series_number: parseInt(getTraitMulti(traits, TRAIT_MAP.seriesNumber) ?? "0", 10),
        is_locked: getTraitMulti(traits, TRAIT_MAP.locked) === "true",
        ingested_at: now,
      });
    }

    // Log how many rows got valid set/play IDs for monitoring
    const resolvedCount = rows.filter(r => r.set_id > 0 && r.play_id > 0).length;
    console.log(`Edition key resolution: ${resolvedCount}/${rows.length} rows have valid set_id/play_id`);
    stats.rowsFound = rows.length;
    stats.extra.resolved_ids = resolvedCount;

    // Dedup by listing_id (the ts_listings PK). Parallel Flowty pages can
    // surface the same listing_id twice when the upstream window shifts mid-
    // run, and Postgres rejects the whole batch with code 21000 ("ON CONFLICT
    // DO UPDATE command cannot affect row a second time") when that happens.
    // Keep the row with the lower ask price per listing_id, mirroring the
    // pattern in app/api/topshot-listing-cache/route.ts.
    const byListingId = new Map();
    for (const row of rows) {
      const prev = byListingId.get(row.listing_id);
      if (!prev) {
        byListingId.set(row.listing_id, row);
        continue;
      }
      if (row.price_usd != null && (prev.price_usd == null || row.price_usd < prev.price_usd)) {
        byListingId.set(row.listing_id, row);
      }
    }
    const dedupedRows = Array.from(byListingId.values());
    if (dedupedRows.length !== rows.length) {
      console.log(`Deduped: ${rows.length} -> ${dedupedRows.length} rows (${rows.length - dedupedRows.length} listing_id collisions)`);
    }
    stats.extra.deduped = dedupedRows.length;
    stats.rowsSkipped = rows.length - dedupedRows.length;

    console.log(`Upserting ${dedupedRows.length} rows...`);
    let upserted = 0;
    for (let i = 0; i < dedupedRows.length; i += 100) {
      const batch = dedupedRows.slice(i, i + 100);
      await upsert(batch);
      upserted += batch.length;
    }
    stats.rowsWritten = upserted;
    if (upserted > 0) {
      await deleteStale();
    } else {
      console.error("Skipping deleteStale: 0 rows upserted (preserves last good data)");
    }
    console.log(`Done. ${upserted} listings ingested.`);
  } catch (err) {
    stats.ok = false;
    stats.errorMsg = err.message;
    console.error("Ingest failed:", err.message);
    exitCode = 1;
  } finally {
    stats.extra.duration_ms = Date.now() - startedAt;
    await logPipelineRun(stats);
    if (exitCode !== 0) process.exit(exitCode);
  }
})();
