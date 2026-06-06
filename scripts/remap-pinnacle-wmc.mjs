// scripts/remap-pinnacle-wmc.mjs
//
// Remaps wallet_moments_cache Pinnacle rows to their true per-pin render_id by
// querying the Dapper studio-platform GraphQL by NFT id (= wmc.moment_id). Each
// NFT returns its edition.render_id + serial_number + shape.name — none of which
// the set-level edition_key could resolve. Loads pinnacle_wmc_remap (staging);
// the SQL UPDATE FROM that applies it is run separately after this completes.
//
// Run: node scripts/remap-pinnacle-wmc.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714";
const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const ID_CHUNK = 250;

const QUERY = `
query RemapByIds($ids: [UInt64!]!) {
  searchPinnacleNft(searchInput: { first: 250, filters: [{ id: { in: $ids } }] }) {
    edges { node { id serial_number edition { render_id shape { name } } } }
  }
}`;

async function fetchByIds(ids) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/remap-pinnacle-wmc",
    },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
  return json.data.searchPinnacleNft.edges.map((e) => e.node);
}

async function main() {
  // 1. Pull every Pinnacle wmc moment_id (paginate past PostgREST 1000 cap).
  const momentIds = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .range(from, from + 999);
    if (error) throw new Error(`wmc page ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) momentIds.push(r.moment_id);
    if (data.length < 1000) break;
  }
  // Distinct (a moment_id can appear once per wallet, but NFT ids are globally unique).
  const distinctIds = [...new Set(momentIds)];
  console.log(`wmc Pinnacle moment_ids: ${momentIds.length} rows, ${distinctIds.length} distinct nft ids`);

  // 2. By-id GraphQL → mappings.
  const mappings = [];
  let resolved = 0;
  let unresolved = 0;
  for (let i = 0; i < distinctIds.length; i += ID_CHUNK) {
    const chunk = distinctIds.slice(i, i + ID_CHUNK);
    let nodes = [];
    try {
      nodes = await fetchByIds(chunk);
    } catch (e) {
      console.error(`\nchunk ${i} error: ${e.message} — retrying once`);
      await new Promise((r) => setTimeout(r, 1500));
      nodes = await fetchByIds(chunk);
    }
    const found = new Set();
    for (const n of nodes) {
      const renderId = n.edition?.render_id ?? null;
      if (!renderId) continue;
      found.add(n.id);
      mappings.push({
        moment_id: n.id,
        render_id: renderId,
        serial_number:
          n.serial_number != null && Number(n.serial_number) > 0 ? Number(n.serial_number) : null,
        shape_name: n.edition?.shape?.name ?? null,
      });
    }
    resolved += found.size;
    unresolved += chunk.length - found.size;
    process.stdout.write(`\rresolved ${resolved}/${distinctIds.length} (unresolved ${unresolved})`);
  }
  console.log("");

  // 3. Bulk upsert into staging.
  let written = 0;
  for (let i = 0; i < mappings.length; i += 500) {
    const batch = mappings.slice(i, i + 500);
    const { error } = await supabase
      .from("pinnacle_wmc_remap")
      .upsert(batch, { onConflict: "moment_id" });
    if (error) throw new Error(`staging batch ${i}: ${error.message}`);
    written += batch.length;
    process.stdout.write(`\rstaged ${written}/${mappings.length}`);
  }
  console.log(`\nDONE — ${mappings.length} mappings staged (unresolved nft ids: ${unresolved})`);
}

main().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
