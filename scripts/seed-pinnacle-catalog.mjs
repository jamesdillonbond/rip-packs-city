// scripts/seed-pinnacle-catalog.mjs
//
// One-time / re-runnable seed of public.pinnacle_catalog (render_id-keyed) from
// the Dapper studio-platform GraphQL. Pages searchPinnacleEditions and upserts
// every edition keyed on render_id (the true per-pin identity), replacing the
// set-level pinnacle_editions.edition_key granularity.
//
// Reachable unauthenticated from datacenter egress with Origin header set.
// Run: node scripts/seed-pinnacle-catalog.mjs
//
// The durable production freshness path is /api/admin/backfill-pinnacle-catalog;
// this script does the initial bulk load from a verified-reachable host.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── env from .env.local ────────────────────────────────────────────────────
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const ASSET_BASE = "https://assets.disneypinnacle.com/render";

const QUERY = `
query SeedPinnacleCatalog($first: Int!, $after: String) {
  searchPinnacleEditions(searchInput: { first: $first, after: $after }) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        id render_id variant printing total_minted chaser parallel_type
        edition_type { name limited_edition }
        series { name }
        set { name render_id }
        shape { name render_id metadata { royalty_codes characters franchises } }
        metadata { color effects materials size thickness }
      }
    }
  }
}`;

// royalty_codes/characters/franchises come back as JSON arrays in data even
// though introspection types them String; tolerate both array and scalar.
function toArr(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.length ? [v] : null;
  return null;
}
function toInt(v) {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchPage(after) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/seed-pinnacle-catalog",
    },
    body: JSON.stringify({ query: QUERY, variables: { first: 100, after } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data.searchPinnacleEditions;
}

function buildRow(node) {
  const renderId = node.render_id;
  if (!renderId) return null;
  const royaltyCodes = toArr(node.shape?.metadata?.royalty_codes);
  const royaltyCode = royaltyCodes?.[0] ?? null;
  const variant = node.variant ?? null;
  const printing = toInt(node.printing);
  const legacyKey =
    royaltyCode && variant != null && printing != null
      ? `${royaltyCode}:${variant}:${printing}`
      : null;
  return {
    render_id: renderId,
    edition_id: String(node.id),
    shape_render_id: node.shape?.render_id ?? null,
    character_name: node.shape?.name ?? null,
    set_name: node.set?.name ?? null,
    set_render_id: node.set?.render_id ?? null,
    variant,
    parallel_type: node.parallel_type ?? null,
    printing,
    total_minted: toInt(node.total_minted),
    edition_type: node.edition_type?.name ?? null,
    limited_edition: node.edition_type?.limited_edition ?? null,
    series_name: node.series?.name ?? null,
    royalty_code: royaltyCode,
    royalty_codes: royaltyCodes,
    franchises: toArr(node.shape?.metadata?.franchises),
    characters: toArr(node.shape?.metadata?.characters),
    color: node.metadata?.color ?? null,
    effects: node.metadata?.effects ?? null,
    materials: node.metadata?.materials ?? null,
    size: node.metadata?.size ?? null,
    thickness: node.metadata?.thickness ?? null,
    is_chaser: node.chaser ?? null,
    legacy_edition_key: legacyKey,
    thumbnail_url: `${ASSET_BASE}/${renderId}/front.png`,
    front_anim_url: `${ASSET_BASE}/${renderId}/front_anim.webp`,
    source: "studio-platform-gql",
    updated_at: new Date().toISOString(),
  };
}

async function main() {
  const all = [];
  let after = null;
  let total = null;
  let page = 0;
  for (;;) {
    const res = await fetchPage(after);
    if (total == null) total = res.totalCount;
    for (const e of res.edges) {
      const row = buildRow(e.node);
      if (row) all.push(row);
    }
    page++;
    process.stdout.write(`\rpage ${page} — collected ${all.length}/${total}`);
    if (!res.pageInfo.hasNextPage) break;
    after = res.pageInfo.endCursor;
  }
  console.log("");

  // Dedup by render_id (defensive — render_id is unique upstream).
  const byRid = new Map();
  for (const r of all) byRid.set(r.render_id, r);
  const rows = [...byRid.values()];
  console.log(`fetched ${all.length} nodes, ${rows.length} distinct render_ids`);

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("pinnacle_catalog")
      .upsert(batch, { onConflict: "render_id" });
    if (error) {
      console.error(`batch ${i} error:`, error.message);
      process.exit(1);
    }
    upserted += batch.length;
    process.stdout.write(`\rupserted ${upserted}/${rows.length}`);
  }
  console.log(`\nDONE — upserted ${upserted} rows into pinnacle_catalog`);

  // Distinctness check on thumbnail_url.
  const urls = new Set(rows.map((r) => r.thumbnail_url));
  console.log(`thumbnail_url distinctness: ${urls.size} distinct / ${rows.length} rows`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
