#!/usr/bin/env node
"use strict";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

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
};

async function fetchFlowtyPage(from) {
  const res = await fetch(FLOWTY_ENDPOINT, {
    method: "POST",
    headers: FLOWTY_HEADERS,
    body: JSON.stringify({
      address: null,
      addresses: [],
      collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
      from,
      includeAllListings: true,
      limit: 24,
      onlyUnlisted: false,
      orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
      sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Flowty HTTP ${res.status} from=${from}: ${await res.text().then(t => t.slice(0, 200))}`);
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

(async () => {
  try {
    const offsets = [0, 24, 48, 72, 96];
    const pages = await Promise.allSettled(offsets.map(o => fetchFlowtyPage(o)));
    const all = [];
    for (const [i, result] of pages.entries()) {
      if (result.status === "fulfilled") {
        console.log(`Page from=${offsets[i]}: ${result.value.length} items`);
        all.push(...result.value);
      } else {
        console.error(`Page from=${offsets[i]} failed: ${result.reason?.message}`);
      }
    }

    // Log first item structure for debugging
    if (all.length > 0) {
      const first = all[0];
      console.log("First item keys:", Object.keys(first).join(", "));
      const order = first.orders?.[0];
      if (order) console.log("First order keys:", Object.keys(order).join(", "), "| salePrice:", order.salePrice);
      console.log("nftView serial:", first.nftView?.serial, "card.num:", first.card?.num, "card.max:", first.card?.max);
    }

    console.log(`Total fetched: ${all.length}`);
    const now = new Date().toISOString();
    const rows = [];
    for (const item of all) {
      const order = item.orders?.find(o => (o.salePrice ?? 0) > 0);
      if (!order) continue;
      const serial = item.nftView?.serial ?? item.card?.num ?? 0;
      if (!serial) continue;
      const traits = Array.isArray(item.nftView?.traits) ? item.nftView.traits : Object.values(item.nftView?.traits ?? {});
      rows.push({
        listing_id: order.listingResourceID ?? String(item.id),
        flow_id: String(item.id),
        set_id: 0,
        play_id: 0,
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
