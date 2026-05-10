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

// Resolve (player_name, set_name, series) tuples → {set_id, play_id} via the
// NBA Top Shot editions table. Flowty stopped returning SetID/PlayID as traits
// at some point before 2026-05-09; the trait-only path resolved 0/120 rows
// every tick. Editions-table fallback covers ~92% of NBA TS editions (9214 of
// 9991 have set_id_onchain + play_id_onchain populated). Single round-trip
// per cron tick.
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd";

async function fetchTopShotEditionsLookup() {
  const out = new Map();
  const url = `${SUPABASE_URL}/rest/v1/editions` +
    `?collection_id=eq.${TS_COLLECTION_ID}` +
    `&set_id_onchain=not.is.null&play_id_onchain=not.is.null` +
    `&select=player_name,set_name,series,set_id_onchain,play_id_onchain` +
    `&limit=20000`;
  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`editions lookup HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows = await res.json();
  for (const row of rows) {
    if (!row.player_name || !row.set_name) continue;
    const key = `${row.player_name.toLowerCase()}|${row.set_name.toLowerCase()}|${row.series ?? 0}`;
    if (!out.has(key)) {
      out.set(key, { set_id: row.set_id_onchain, play_id: row.play_id_onchain });
    }
  }
  return out;
}

function lookupEditionKey(map, playerName, setName, seriesNumber) {
  if (!playerName || !setName) return null;
  const key = `${playerName.toLowerCase()}|${setName.toLowerCase()}|${seriesNumber ?? 0}`;
  return map.get(key) ?? null;
}

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

// PostgREST returns PGRST003 ("Timed out acquiring connection from pool")
// when other pipelines are holding the pool exhausted. Surface as a
// retryable error and back off twice (5s, then 15s) before giving up.
function isPgrst003(text) {
  return typeof text === "string" && text.includes("PGRST003");
}

async function upsertOnce(rows) {
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
    const text = await res.text();
    const err = new Error(`Supabase upsert ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    err.retryable = res.status === 504 || isPgrst003(text);
    throw err;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsert(rows) {
  const backoffsMs = [0, 5000, 15000];
  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (backoffsMs[attempt] > 0) await sleep(backoffsMs[attempt]);
    try {
      await upsertOnce(rows);
      if (attempt > 0) {
        console.log(`upsert retry succeeded on attempt ${attempt + 1}`);
      }
      return;
    } catch (err) {
      const last = attempt === backoffsMs.length - 1;
      if (!err.retryable || last) {
        if (err.retryable && last) {
          console.error(`upsert retries exhausted (PGRST003/504): ${err.message}`);
        }
        throw err;
      }
      console.log(`upsert PGRST003/504 hit, retrying in ${backoffsMs[attempt + 1]}ms (attempt ${attempt + 1}/${backoffsMs.length})`);
    }
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

    // Fetch the editions lookup map once per run. Used as a fallback when
    // Flowty doesn't surface SetID/PlayID traits (which has been all of the
    // time since at least 2026-05-09).
    let editionsLookup = new Map();
    try {
      editionsLookup = await fetchTopShotEditionsLookup();
      console.log(`Loaded ${editionsLookup.size} TS edition lookup tuples`);
    } catch (err) {
      console.error(`editions lookup failed: ${err.message} — falling back to trait-only resolution`);
    }

    const now = new Date().toISOString();
    const rows = [];
    let skippedNoIds = 0;
    let traitResolved = 0;
    let lookupResolved = 0;
    for (const item of all) {
      const order = item.orders?.find(o => (o.salePrice ?? 0) > 0);
      if (!order) continue;
      const serial = item.nftView?.serial ?? item.card?.num ?? 0;
      if (!serial) continue;
      const traits = flattenTraits(item.nftView?.traits);

      // First-try: extract integer set/play IDs from Flowty NFT traits. Cheap
      // and handles the case where Flowty restores the schema upstream.
      let setId = parseInt(getTraitMulti(traits, TRAIT_MAP.setID) ?? "0", 10) || 0;
      let playId = parseInt(getTraitMulti(traits, TRAIT_MAP.playID) ?? "0", 10) || 0;
      const fromTraits = setId > 0 && playId > 0;

      const playerName = item.card?.title ?? null;
      const setName = getTraitMulti(traits, TRAIT_MAP.setName) ?? null;
      const seriesNumber = parseInt(getTraitMulti(traits, TRAIT_MAP.seriesNumber) ?? "0", 10) || 0;

      // Fallback: resolve via editions table by (player, set, series) tuple.
      if (!fromTraits) {
        const hit = lookupEditionKey(editionsLookup, playerName, setName, seriesNumber);
        if (hit) {
          setId = hit.set_id;
          playId = hit.play_id;
          lookupResolved += 1;
        }
      } else {
        traitResolved += 1;
      }

      // Fail-safe: skip the row entirely rather than upsert zeros that
      // poison downstream FMV joins.
      if (!(setId > 0 && playId > 0)) {
        skippedNoIds += 1;
        if (skippedNoIds <= 3) {
          console.warn(
            `[ts-ingest] skipping row: no set_id/play_id for ` +
            `player="${playerName}" set="${setName}" series=${seriesNumber} flow_id=${item.id}`
          );
        }
        continue;
      }

      rows.push({
        listing_id: order.listingResourceID ?? String(item.id),
        flow_id: String(item.id),
        set_id: setId,
        play_id: playId,
        parallel_id: 0,
        serial_number: serial,
        circulation_count: item.card?.max ?? 0,
        price_usd: order.salePrice,
        seller_address: order.storefrontAddress ?? order.flowtyStorefrontAddress ?? null,
        player_name: playerName,
        set_name: setName,
        moment_tier: (getTraitMulti(traits, TRAIT_MAP.tier) ?? "COMMON").toUpperCase(),
        series_number: seriesNumber,
        is_locked: getTraitMulti(traits, TRAIT_MAP.locked) === "true",
        ingested_at: now,
      });
    }

    const resolvedCount = rows.filter(r => r.set_id > 0 && r.play_id > 0).length;
    console.log(
      `Edition key resolution: ${resolvedCount}/${all.length} rows kept ` +
      `(traits=${traitResolved}, editions-lookup=${lookupResolved}, skipped=${skippedNoIds})`
    );
    if (skippedNoIds > 3) {
      console.warn(`[ts-ingest] ${skippedNoIds - 3} additional skipped rows suppressed`);
    }
    stats.rowsFound = rows.length;
    stats.extra.resolved_ids = resolvedCount;
    stats.extra.skipped_no_ids = skippedNoIds;
    stats.extra.trait_resolved = traitResolved;
    stats.extra.lookup_resolved = lookupResolved;

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
