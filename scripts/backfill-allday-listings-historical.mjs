#!/usr/bin/env node
/**
 * scripts/backfill-allday-listings-historical.mjs
 *
 * One-shot backfill for the 5.5-month temporal gap in cached_listings_v2 for
 * the AllDay direct indexer (cause 1 of the 97% divergence per
 * docs/audits/listing-divergence-2026-05.md). The live indexer
 * (app/api/allday-listings-indexer/route.ts) anchors its cursor at the
 * sealed tip on first run with no historical backscan, so every listing
 * fired before its first cron tick (~2026-05-09) is invisible to the
 * direct source. Flowty's source goes back to 2025-11-22, which is where
 * this backfill aims.
 *
 * Usage:
 *   node scripts/backfill-allday-listings-historical.mjs --dry-run
 *   node scripts/backfill-allday-listings-historical.mjs
 *   node scripts/backfill-allday-listings-historical.mjs --floor-date=2025-11-22
 *   node scripts/backfill-allday-listings-historical.mjs --floor-block=140000000
 *
 * Resolver strategy: cheap wmc + nft_edition_map lookups inline; unresolved
 * events upsert into listing_resolution_failures with the full event_payload
 * so the existing every-15min retry cron (Round 7 Item 2) picks them up with its
 * bumped CADENCE_FALLBACK_MAX_RETRY=32. This script intentionally skips the
 * Cadence borrow path itself — running it inline against hundreds of
 * thousands of historical events would burn way too many Flow access calls.
 *
 * Two-regime walker:
 *   - Current spork (>= 137,390,146): hit rest-mainnet.onflow.org directly.
 *   - Pre-spork (<= 137,390,145): route through spork-proxy.tdillonbond.workers.dev.
 *
 * Throttled at ~15 req/s to stay under the 20 req/s ceiling on the proxy.
 * 250 blocks per request (the spork-proxy max). Logs to pipeline_runs as
 * 'allday-listings-historical-backfill' with full counters.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// ── Self-parse .env.local ───────────────────────────────────────────────────
try {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070";
const ALLDAY_NFT_TYPE_ID = "A.e4cf4bdc1751c65d.AllDay.NFT";
const STOREFRONT_LISTING_AVAILABLE = "A.3cdbb3d569211ff3.NFTStorefrontV2.ListingAvailable";

// Spork boundary — matches workers/spork-proxy/index.ts.
const CURRENT_SPORK_MIN_HEIGHT = 137_390_146;
const FLOW_REST = "https://rest-mainnet.onflow.org";
const SPORK_PROXY = "https://spork-proxy.tdillonbond.workers.dev";
const SPORK_PROXY_SECRET = process.env.SPORK_PROXY_SECRET;

const CHUNK_SIZE = 250;          // spork-proxy max range per call
const RATE_LIMIT_DELAY_MS = 67;  // ~15 req/s
const FETCH_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const floorDateArg = args.find((a) => a.startsWith("--floor-date="));
const floorBlockArg = args.find((a) => a.startsWith("--floor-block="));

// Default floor: 2025-11-22 (earliest Flowty listing timestamp per the
// audit; everything older has no flowty observation to align against
// either). Override via --floor-date or --floor-block.
const DEFAULT_FLOOR_DATE = "2025-11-22";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Cadence value unwrapper — strips the {type, value} envelope at every level
// so the resulting payload looks like normal JSON. Mirrors the helper in
// app/api/allday-listings-indexer/route.ts.
function unwrapCdc(node) {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(unwrapCdc);
  if (typeof node !== "object") return node;
  const { type, value } = node;
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value);
      case "Bool": case "String": case "Address": case "Path": case "Character":
        return value;
      case "Int": case "UInt":
      case "Int8": case "Int16": case "Int32": case "Int64": case "Int128": case "Int256":
      case "UInt8": case "UInt16": case "UInt32": case "UInt64": case "UInt128": case "UInt256":
      case "Word8": case "Word16": case "Word32": case "Word64":
      case "Fix64": case "UFix64":
        return value;
      case "Array":
        return value.map(unwrapCdc);
      case "Dictionary":
        return Object.fromEntries(value.map(({ key, value: v }) => [unwrapCdc(key), unwrapCdc(v)]));
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
        const out = {};
        for (const field of value.fields ?? []) out[field.name] = unwrapCdc(field.value);
        return out;
      }
      case "Type":
        return value.staticType ?? value;
      default:
        return value;
    }
  }
  return node;
}

function extractTypeId(field) {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") {
    const st = field.staticType;
    if (typeof st === "string") return st;
    if (st && typeof st === "object") {
      const id = st.typeID;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

async function fetchEventRange(startHeight, endHeight) {
  // Pick regime: current-spork via rest-mainnet, pre-spork via spork-proxy.
  if (startHeight >= CURRENT_SPORK_MIN_HEIGHT) {
    const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(STOREFRONT_LISTING_AVAILABLE)}&start_height=${startHeight}&end_height=${endHeight}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`rest-mainnet HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  }
  if (!SPORK_PROXY_SECRET) {
    throw new Error("SPORK_PROXY_SECRET required for pre-spork blocks (height < 137,390,146)");
  }
  const url = `${SPORK_PROXY}/?event_type=${encodeURIComponent(STOREFRONT_LISTING_AVAILABLE)}&start_height=${startHeight}&end_height=${endHeight}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SPORK_PROXY_SECRET}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`spork-proxy HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

async function getLatestSealedHeight() {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`);
  const json = await res.json();
  return Number(json[0]?.header?.height ?? 0);
}

async function getHeightAtTimestamp(targetIso) {
  // Approximate: walk backwards in delta-second jumps from sealed, stop
  // when block_timestamp <= target. rest-mainnet only serves
  // current-spork blocks (height >= 137,390,146); if the target date
  // falls pre-spork, cap at the spork floor and let the caller decide
  // whether to override via --floor-block.
  const target = new Date(targetIso).getTime();
  const sealed = await getLatestSealedHeight();
  let height = sealed;
  while (height >= CURRENT_SPORK_MIN_HEIGHT) {
    const res = await fetch(`${FLOW_REST}/v1/blocks?height=${height}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[backfill] block lookup at ${height} HTTP ${res.status} — capping floor at CURRENT_SPORK_MIN_HEIGHT`);
      return CURRENT_SPORK_MIN_HEIGHT;
    }
    const json = await res.json();
    const ts = new Date(json[0]?.header?.timestamp ?? 0).getTime();
    if (ts <= target) return height;
    const deltaSec = Math.floor((ts - target) / 1000);
    if (deltaSec < 1000) return Math.max(CURRENT_SPORK_MIN_HEIGHT, height - deltaSec - 100);
    const step = Math.min(2_000_000, deltaSec);
    height = height - step;
  }
  // Target falls pre-spork. Pre-spork block-by-height lookup isn't wired
  // through the spork-proxy (it's events-only). Operator can override
  // via --floor-block if they really want to walk into mainnet26.
  console.warn(
    `[backfill] target date ${targetIso} resolves pre-spork; capping floor at ` +
    `CURRENT_SPORK_MIN_HEIGHT=${CURRENT_SPORK_MIN_HEIGHT}. Re-invoke with ` +
    `--floor-block=<height> to walk into pre-spork sporks.`
  );
  return CURRENT_SPORK_MIN_HEIGHT;
}

async function loadEditionResolutionMaps(nftIds) {
  // Two-layer cheap resolver: wmc.edition_key + nft_edition_map.
  // The expensive Cadence-borrow path is deliberately skipped in this
  // script — unresolved events go to listing_resolution_failures so the
  // /15 retry cron handles them at sustainable rate.
  const out = new Map();
  const idList = [...new Set(nftIds)];
  for (let i = 0; i < idList.length; i += 500) {
    const batch = idList.slice(i, i + 500);
    const { data } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, edition_key")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("moment_id", batch);
    for (const row of data ?? []) {
      if (row.edition_key) out.set(row.moment_id, row.edition_key);
    }
  }
  const stillMissing = idList.filter((id) => !out.has(id));
  for (let i = 0; i < stillMissing.length; i += 500) {
    const batch = stillMissing.slice(i, i + 500);
    const { data } = await supabase
      .from("nft_edition_map")
      .select("nft_id, edition_external_id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("nft_id", batch);
    for (const row of data ?? []) {
      if (row.edition_external_id) out.set(row.nft_id, row.edition_external_id);
    }
  }
  return out;
}

async function resolveEditionUuids(externalIds) {
  const out = new Map();
  const ids = [...new Set(externalIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const { data } = await supabase
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("external_id", batch);
    for (const row of data ?? []) out.set(row.external_id, row.id);
  }
  return out;
}

function deriveCurrency(vaultTypeId) {
  if (!vaultTypeId) return "UNKNOWN";
  if (vaultTypeId.includes("DapperUtilityCoin")) return "DUC";
  if (vaultTypeId.includes("FlowUtilityToken")) return "FUT";
  if (vaultTypeId.includes("FlowToken")) return "FLOW";
  if (vaultTypeId.includes("FUSD")) return "FUSD";
  return vaultTypeId;
}

function isUsdEquivalent(currency) {
  return currency === "DUC" || currency === "FUT";
}

function epochSecondsToIso(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

async function main() {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  // Determine ceiling (start of walk = earliest known direct row).
  const { data: ceilingRow } = await supabase
    .from("cached_listings_v2")
    .select("block_height, listed_at")
    .eq("collection_id", ALLDAY_COLLECTION_ID)
    .eq("source", "direct")
    .order("block_height", { ascending: true })
    .limit(1);
  const ceilingBlock = Number(ceilingRow?.[0]?.block_height ?? 0);
  if (!ceilingBlock) {
    console.error("[backfill] no existing direct rows — can't anchor ceiling");
    process.exit(1);
  }
  console.log(`[backfill] ceiling: earliest direct row at block=${ceilingBlock} listed_at=${ceilingRow[0].listed_at}`);

  // Determine floor.
  let floorBlock;
  if (floorBlockArg) {
    floorBlock = Number(floorBlockArg.split("=")[1]);
  } else {
    const floorDate = floorDateArg ? floorDateArg.split("=")[1] : DEFAULT_FLOOR_DATE;
    console.log(`[backfill] resolving floor date ${floorDate} to a block height...`);
    floorBlock = await getHeightAtTimestamp(floorDate);
    console.log(`[backfill] floor: date=${floorDate} block=${floorBlock}`);
  }
  if (floorBlock >= ceilingBlock) {
    console.log(`[backfill] floor (${floorBlock}) >= ceiling (${ceilingBlock}) — nothing to walk`);
    return;
  }

  const totalBlocks = ceilingBlock - floorBlock;
  console.log(
    `[backfill] walking ${totalBlocks.toLocaleString()} blocks BACKWARDS ` +
    `from ${ceilingBlock} → ${floorBlock} (~${Math.ceil(totalBlocks / CHUNK_SIZE).toLocaleString()} requests)`
  );
  if (dryRun) {
    console.log("[backfill] DRY RUN — exiting before fetching any events");
    return;
  }

  let blocksScanned = 0;
  let eventsFound = 0;
  let eventsResolvedToCachedListings = 0;
  let eventsIntoRetryQueue = 0;
  let requests = 0;
  let requestErrors = 0;
  const sporkCrossings = [];

  // Walk in descending chunks. spork-proxy rejects ranges that cross the
  // spork boundary, so we split at CURRENT_SPORK_MIN_HEIGHT when needed.
  let cursor = ceilingBlock - 1;
  while (cursor >= floorBlock) {
    let chunkEnd = cursor;
    let chunkStart = Math.max(floorBlock, cursor - CHUNK_SIZE + 1);
    // Avoid spanning the spork boundary in a single fetch.
    if (chunkStart < CURRENT_SPORK_MIN_HEIGHT && chunkEnd >= CURRENT_SPORK_MIN_HEIGHT) {
      chunkStart = CURRENT_SPORK_MIN_HEIGHT;
      sporkCrossings.push({ at: chunkEnd, split_at: CURRENT_SPORK_MIN_HEIGHT });
    }

    requests++;
    let blocks;
    try {
      blocks = await fetchEventRange(chunkStart, chunkEnd);
    } catch (err) {
      requestErrors++;
      console.warn(`[backfill] fetch ${chunkStart}-${chunkEnd} failed: ${err.message}`);
      cursor = chunkStart - 1;
      await delay(RATE_LIMIT_DELAY_MS);
      continue;
    }

    const availableEvents = [];
    for (const blk of blocks ?? []) {
      const bh = Number(blk.block_height);
      const bts = blk.block_timestamp;
      for (const evt of blk.events ?? []) {
        try {
          const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"));
          const payload = unwrapCdc(raw);
          const nftTypeId = extractTypeId(payload?.nftType);
          if (!nftTypeId || !nftTypeId.includes("AllDay")) continue;
          if (nftTypeId !== ALLDAY_NFT_TYPE_ID && !nftTypeId.includes(".AllDay.NFT")) continue;
          const storefrontAddress = typeof payload.storefrontAddress === "string" ? payload.storefrontAddress : null;
          if (!storefrontAddress) continue;
          availableEvents.push({
            blockHeight: bh,
            blockTimestamp: bts,
            txHash: evt.transaction_id,
            eventIndex: evt.event_index,
            listingResourceID: String(payload.listingResourceID),
            storefrontAddress,
            nftID: String(payload.nftID),
            salePrice: String(payload.salePrice ?? "0"),
            salePaymentVaultType: extractTypeId(payload.salePaymentVaultType),
            customID: typeof payload.customID === "string" ? payload.customID : null,
            expiry: payload.expiry !== undefined && payload.expiry !== null ? String(payload.expiry) : undefined,
          });
        } catch {
          // Skip undecodeable events — same behaviour as the live indexer.
        }
      }
    }
    eventsFound += availableEvents.length;
    blocksScanned += (chunkEnd - chunkStart + 1);

    if (availableEvents.length > 0) {
      const nftIds = availableEvents.map((e) => e.nftID);
      const nftToExternal = await loadEditionResolutionMaps(nftIds);
      const externalToUuid = await resolveEditionUuids([...nftToExternal.values()]);

      const v2Rows = [];
      const failuresQueue = [];
      for (const a of availableEvents) {
        const externalId = nftToExternal.get(a.nftID);
        const uuid = externalId ? externalToUuid.get(externalId) : null;
        if (!uuid) {
          failuresQueue.push({
            collection_id: ALLDAY_COLLECTION_ID,
            flow_id: a.nftID,
            listing_resource_id: a.listingResourceID,
            event_payload: a,
            failure_reason: externalId
              ? "edition_external_id_not_in_editions_table"
              : "wmc_miss_historical_backfill",
          });
          continue;
        }
        const currency = deriveCurrency(a.salePaymentVaultType);
        const salePriceNum = parseFloat(a.salePrice) || 0;
        const priceUsd = isUsdEquivalent(currency) ? salePriceNum : null;
        v2Rows.push({
          listing_resource_id: a.listingResourceID,
          source: "direct",
          flow_id: a.nftID,
          edition_id: uuid,
          collection_id: ALLDAY_COLLECTION_ID,
          seller_address: a.storefrontAddress,
          price_usd: priceUsd,
          currency,
          custom_id: a.customID,
          listed_at: a.blockTimestamp,
          expiry_at: epochSecondsToIso(a.expiry),
          completed_at: null,
          completed_status: null,
          block_height: a.blockHeight,
          tx_hash: a.txHash,
          event_index: a.eventIndex,
        });
      }

      for (let i = 0; i < v2Rows.length; i += 100) {
        const batch = v2Rows.slice(i, i + 100);
        const { error } = await supabase
          .from("cached_listings_v2")
          .upsert(batch, { onConflict: "listing_resource_id,source", ignoreDuplicates: true });
        if (error) console.warn(`[backfill] v2 upsert err: ${error.message}`);
        else eventsResolvedToCachedListings += batch.length;
      }
      for (let i = 0; i < failuresQueue.length; i += 100) {
        const batch = failuresQueue.slice(i, i + 100);
        const { error } = await supabase
          .from("listing_resolution_failures")
          .upsert(batch, { onConflict: "collection_id,listing_resource_id", ignoreDuplicates: true });
        if (error) console.warn(`[backfill] failure-queue upsert err: ${error.message}`);
        else eventsIntoRetryQueue += batch.length;
      }
    }

    if (requests % 25 === 0) {
      console.log(
        `[backfill] requests=${requests} blocks_scanned=${blocksScanned.toLocaleString()} ` +
        `events_found=${eventsFound} resolved=${eventsResolvedToCachedListings} queued=${eventsIntoRetryQueue} ` +
        `cursor=${chunkStart}`
      );
    }

    cursor = chunkStart - 1;
    await delay(RATE_LIMIT_DELAY_MS);
  }

  const durationMs = Date.now() - startedAtMs;
  const summary = {
    floor_block: floorBlock,
    ceiling_block: ceilingBlock,
    blocks_scanned: blocksScanned,
    events_found: eventsFound,
    events_resolved: eventsResolvedToCachedListings,
    events_into_retry_queue: eventsIntoRetryQueue,
    requests,
    request_errors: requestErrors,
    spork_crossings: sporkCrossings.length,
    duration_ms: durationMs,
  };
  console.log(`[backfill] done — ${JSON.stringify(summary)}`);

  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: "allday-listings-historical-backfill",
      p_started_at: startedAtIso,
      p_rows_found: eventsFound,
      p_rows_written: eventsResolvedToCachedListings,
      p_rows_skipped: eventsIntoRetryQueue,
      p_ok: requestErrors === 0,
      p_error: requestErrors > 0 ? `${requestErrors} fetch failures` : null,
      p_collection_slug: "nfl_all_day",
      p_cursor_before: String(ceilingBlock),
      p_cursor_after: String(floorBlock),
      p_extra: summary,
    });
  } catch (err) {
    console.warn(`[backfill] log_pipeline_run failed: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`[backfill] fatal: ${err.message ?? err}`);
  process.exit(1);
});
