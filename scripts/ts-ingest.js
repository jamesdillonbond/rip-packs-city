#!/usr/bin/env node
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TS_GQL = "https://public-api.nbatopshot.com/graphql";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

// Minimal query - only fields we know exist, log full response to discover schema
const QUERY = `{
  searchMomentListings(
    input: {
      filters: {}
      searchInput: { pagination: { cursor: "CURSOR_PLACEHOLDER", direction: RIGHT, limit: 100 } }
    }
  ) {
    data {
      searchSummary {
        pagination { rightCursor }
        data {
          ... on MomentListings {
            data {
              ... on MomentListing {
                id
                serialNumber
                circulationCount
                setName
                momentTier
                momentTitle
                playerName
                isLocked
                storefrontListingID
                listingOrderID
                sellerAddress
                setSeriesNumber
                setPlay { setID playID parallelID }
              }
            }
          }
        }
      }
    }
  }
}`;

async function fetchPage(cursor) {
  const query = QUERY.replace("CURSOR_PLACEHOLDER", cursor || "");
  const res = await fetch(TS_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "application/json",
      "Origin": "https://nbatopshot.com",
      "Referer": "https://nbatopshot.com/",
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TS GQL ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) throw new Error(json.errors.map(e => e.message).join("; "));
  const summary = json?.data?.searchMomentListings?.data?.searchSummary;
  const nextCursor = summary?.pagination?.rightCursor ?? null;
  const listings = [];
  const dataField = summary?.data;
  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      if (Array.isArray(block?.data)) listings.push(...block.data);
    }
  } else if (dataField?.data && Array.isArray(dataField.data)) {
    listings.push(...dataField.data);
  }
  // Log first item to discover available price fields
  if (listings.length > 0) {
    console.log("Sample listing keys:", Object.keys(listings[0]).join(", "));
    console.log("Sample listing:", JSON.stringify(listings[0]).slice(0, 500));
  }
  console.log(`  Page: ${listings.length} listings, nextCursor=${nextCursor ? "yes" : "none"}`);
  return { listings, nextCursor };
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
    headers: {
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey": SUPABASE_KEY,
    },
  });
  if (!res.ok) console.error(`Stale delete failed: ${res.status}`);
}

(async () => {
  try {
    const all = [];
    let cursor = null;
    let page = 1;
    do {
      console.log(`Fetching page ${page}...`);
      const { listings, nextCursor } = await fetchPage(cursor);
      all.push(...listings);
      cursor = nextCursor;
      page++;
      if (page > 2) break; // Only 2 pages for now while discovering schema
    } while (cursor && all.length < 200);

    console.log(`Total fetched: ${all.length}`);

    const now = new Date().toISOString();
    const rows = all
      .filter(l => l.setPlay?.setID && l.setPlay?.playID && l.serialNumber)
      .map(l => ({
        listing_id: l.listingOrderID ?? l.storefrontListingID ?? l.id,
        flow_id: String(l.id),
        set_id: parseInt(l.setPlay.setID, 10),
        play_id: parseInt(l.setPlay.playID, 10),
        parallel_id: parseInt(l.setPlay.parallelID ?? 0, 10),
        serial_number: l.serialNumber,
        circulation_count: l.circulationCount ?? 0,
        price_usd: 0, // Will fix once we know the price field name
        seller_address: l.sellerAddress ?? null,
        player_name: l.playerName ?? l.momentTitle ?? null,
        set_name: l.setName ?? null,
        moment_tier: (l.momentTier ?? "COMMON").replace("MOMENT_TIER_", ""),
        series_number: l.setSeriesNumber ?? null,
        is_locked: l.isLocked ?? false,
        ingested_at: now,
      }));

    console.log(`Upserting ${rows.length} rows...`);
    for (let i = 0; i < rows.length; i += 100) {
      await upsert(rows.slice(i, i + 100));
    }
    await deleteStale();
    console.log(`Done. ${rows.length} listings ingested.`);
  } catch (err) {
    console.error("Ingest failed:", err.message);
    process.exit(1);
  }
})();
