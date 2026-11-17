#!/usr/bin/env node
/**
 * scripts/dq2-resolve-uuid-editions.mjs
 *
 * DQ2 cohort B/C/D resolution. Resolves every UUID-keyed TopShot dupe edition
 * (external_id = setUUID:playUUID) to its on-chain integer setID:playID via the
 * Top Shot GQL searchEditions API (through topshot-proxy), and writes the
 * mapping into public.audit_dq2_uuid_resolve.
 *
 * Resolution is BATCHED BY SET: one searchEditions call per distinct setUUID
 * (bySetIDs:[set], byPlayIDs:[all its dupe plays]) returns every edition in that
 * set, and we map each response row back by play.id (UUID). Single set per call
 * means no cross-product. A few hundred calls instead of thousands avoids the
 * upstream rate limit that one-call-per-pair trips.
 *
 * Read-only against `editions` (the dedup trigger blocks in-place onchain-id
 * writes); a follow-up migration MERGEs each dupe into an existing int-keyed
 * canonical or PROMOTEs it (rename external_id to int-form) when none exists.
 *
 * Run locally: node scripts/dq2-resolve-uuid-editions.mjs
 * Requires in .env.local: SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, TS_PROXY_URL, TS_PROXY_SECRET.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const lines = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    console.error("Could not read .env.local — run from project root");
    process.exit(1);
  }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TS_PROXY_URL = process.env.TS_PROXY_URL;
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET;
const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd";
if (!SUPABASE_URL || !SUPABASE_KEY || !TS_PROXY_URL) {
  console.error("[dq2] Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / TS_PROXY_URL");
  process.exit(1);
}

const sbHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" };
async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: { ...sbHeaders, Prefer: "return=representation" } });
  if (!res.ok) throw new Error(`SELECT ${table} ${res.status} ${await res.text()}`);
  return res.json();
}
async function sbUpsert(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/audit_dq2_uuid_resolve?on_conflict=dupe_id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`UPSERT ${res.status} ${await res.text()}`);
}

const QUERY = `
  query SearchEditionBatch($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary { data { ... on Editions { data { ... on Edition {
        set { flowId } play { id flowID } circulationCount tier
      } } } } }
    }
  }`;

const proxyHeaders = () => {
  const h = { "Content-Type": "application/json", "User-Agent": "rpc-dq2-resolve/2.0" };
  if (TS_PROXY_SECRET) h["X-Proxy-Secret"] = TS_PROXY_SECRET;
  return h;
};

function normTier(raw) {
  if (!raw) return null;
  const t = String(raw).replace(/^MOMENT_TIER_/, "").toUpperCase();
  return ["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"].includes(t) ? t : null;
}

// Resolve one set: returns Map<playUUID, {setId, playId, tier, circulation}>
async function resolveSet(setUUID, playUUIDs) {
  const res = await fetch(TS_PROXY_URL, {
    method: "POST",
    headers: proxyHeaders(),
    body: JSON.stringify({
      operationName: "SearchEditionBatch",
      query: QUERY,
      variables: {
        input: {
          filters: { bySetIDs: [setUUID], byPlayIDs: playUUIDs },
          searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: Math.min(500, Math.max(50, playUUIDs.length)) } },
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0]?.message || "GQL error");
  const rows = json?.data?.searchEditions?.searchSummary?.data?.data ?? [];
  const out = new Map();
  for (const r of rows) {
    const playUUID = r.play?.id;
    const setId = r.set?.flowId != null ? parseInt(String(r.set.flowId), 10) : null;
    const playId = r.play?.flowID != null ? parseInt(String(r.play.flowID), 10) : null;
    if (!playUUID || !Number.isFinite(setId) || !Number.isFinite(playId)) continue;
    out.set(playUUID, { setId, playId, tier: normTier(r.tier), circulation: r.circulationCount != null ? Number(r.circulationCount) : null });
  }
  return out;
}

async function main() {
  const dupes = [];
  let offset = 0;
  const page = 1000;
  while (true) {
    const rows = await sbSelect("editions", `select=id,external_id&collection_id=eq.${TS_COLLECTION}&external_id=like.*-*&order=id&offset=${offset}&limit=${page}`);
    dupes.push(...rows);
    if (rows.length < page) break;
    offset += page;
  }

  // Group by setUUID. Only setUUID:playUUID pairs (skip single-UUID/other format).
  const bySet = new Map();
  let skipped = 0;
  for (const d of dupes) {
    const [setUUID, playUUID] = String(d.external_id || "").split(":");
    if (!setUUID || !playUUID || !setUUID.includes("-") || !playUUID.includes("-")) { skipped++; continue; }
    if (!bySet.has(setUUID)) bySet.set(setUUID, []);
    bySet.get(setUUID).push({ dupe_id: d.id, external_id: d.external_id, playUUID });
  }
  const sets = [...bySet.keys()];
  console.log(`[dq2] ${dupes.length} UUID dupes -> ${sets.length} distinct sets (${skipped} non-pair skipped)`);

  let resolved = 0, failed = 0, setsDone = 0;
  const buffer = [];
  const CONCURRENCY = 1, DELAY = 500;
  let si = 0;

  async function worker() {
    while (si < sets.length) {
      const setUUID = sets[si++];
      const items = bySet.get(setUUID);
      let map = null;
      try { map = await resolveSet(setUUID, items.map((x) => x.playUUID)); } catch { map = null; }
      for (const it of items) {
        const r = map?.get(it.playUUID) ?? null;
        buffer.push({
          dupe_id: it.dupe_id,
          dupe_external_id: it.external_id,
          set_id_onchain: r?.setId ?? null,
          play_id_onchain: r?.playId ?? null,
          canonical_key: r ? `${r.setId}:${r.playId}` : null,
          tier: r?.tier ?? null,
          circulation: r?.circulation ?? null,
          resolved_ok: !!r,
        });
        if (r) resolved++; else failed++;
      }
      setsDone++;
      if (buffer.length >= 200) await sbUpsert(buffer.splice(0, buffer.length)).catch((e) => console.warn("[dq2] upsert warn", e.message));
      if (setsDone % 50 === 0) console.log(`[dq2] sets ${setsDone}/${sets.length} (ok ${resolved} / fail ${failed})`);
      await new Promise((r) => setTimeout(r, DELAY));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (buffer.length) await sbUpsert(buffer);
  console.log(`[dq2] DONE — sets ${setsDone}, resolved ${resolved}, failed ${failed}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[dq2] FATAL", e); process.exit(1); });
