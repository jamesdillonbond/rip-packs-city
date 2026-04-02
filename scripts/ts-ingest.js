#!/usr/bin/env node
"use strict";

// Ingest Top Shot listings via Flowty API (proven to work, richer data than TS GQL)
// Populates ts_listings table as fallback for sniper-feed when live feeds are blocked

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot";
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
};

const FLOWTY_TRAIT_MAP = {
  fullName: ["Full Name", "Player Name"],
  setName: ["Set Name", "setName"],
  teamName: ["Team", "teamName"],
  tier: ["Tier", "tier"],
  seriesNumber: ["Series", "seriesNumber"],
  subedition: ["Subedition ID", "subeditionId"],
  locked: ["Locked", "locked"],
};

function getTraitMulti(traits, keys) {
  for (const key of keys) {
    const t = traits.find(t => t.name === key);
    if (t?.value) return t.value;
  }
  return null;
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

async function fetchFlowtyPage(from) {
  const res = await fetch(FLOWTY_ENDPOINT, {
    method: "POST",
    headers: FLOWTY_HEADERS,
    body: JSON.stringify({
      from,
      size: 24,
      filters: {},
      sort: [{ field: "updated_at", order: "desc" }],
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Flowty ${res.status} at from=${from}`);
  const json = await res.json();
  return json?.nfts ?? [];
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

    console.log(`Total fetched: ${all.length}`);
    const now = new Date().toISOString();

    const rows = [];
    for (const item of all) {
      const order = item.orders?.find(o => (o.salePrice ?? 0) > 0) ?? item.orders?.[0];
      if (!order?.listingResourceID || order.salePrice <= 0) continue;

      const traits = item.nftView?.traits ?? [];
      const serial = item.card?.num ?? item.nftView?.serial ?? 0;
      if (!serial) continue;

      rows.push({
        listing_id: order.listingResourceID,
        flow_id: String(item.id),
        set_id: 0, // Not available from Flowty — use 0 as placeholder
        play_id: 0,
        parallel_id: 0,
        serial_number: serial,
        circulation_count: item.card?.max ?? 0,
        price_usd: order.salePrice,
        seller_address: order.storefrontAddress ?? order.flowtyStorefrontAddress ?? null,
        player_name: item.card?.title ?? getTraitMulti(traits, FLOWTY_TRAIT_MAP.fullName) ?? null,
        set_name: getTraitMulti(traits, FLOWTY_TRAIT_MAP.setName) ?? null,
        moment_tier: (getTraitMulti(traits, FLOWTY_TRAIT_MAP.tier) ?? "COMMON").toUpperCase(),
        series_number: parseInt(getTraitMulti(traits, FLOWTY_TRAIT_MAP.seriesNumber) ?? "0", 10),
        is_locked: getTraitMulti(traits, FLOWTY_TRAIT_MAP.locked) === "true",
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
