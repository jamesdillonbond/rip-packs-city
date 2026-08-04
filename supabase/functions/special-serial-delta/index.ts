// supabase/functions/special-serial-delta/index.ts
// Phase 1H. Daily refresh of ownership for tracked NFTs that traded in the
// last 24 hours. Cron-scheduled every 30 minutes via cron-job.org targeting
// this function URL with the INGEST_SECRET_TOKEN bearer header.
//
// Result set is small (typically a handful of trades per day), so this runs
// inline and returns the count when done — no async dispatch needed.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const COLLECTION_IDS = {
  topshot:  "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday:   "dee28451-5d62-409e-a1ad-a83f763ac070",
  golazos:  "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc:      "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
} as const;

const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev/topshot";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";
const TS_GQL_OWNER_QUERY = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{owner{flowAddress}}}}}`;

const REQ_THROTTLE_MS = 50;

interface TrackedRow {
  edition_id: string;
  badge_type: string;
  serial_number: number;
  nft_id: string | null;
  collection_id: string;
  set_id_onchain: number | null;
  play_id_onchain: number | null;
  external_id: string | null;
}

interface OwnershipResult {
  nft_id: string | null;
  holder_address: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Same per-collection resolvers as the sweep function — keep stub-aligned
// so when the GQL/Cadence wiring lands in special-serial-sweep, the same
// helpers can be lifted into a shared module imported by both functions.

function toFlowAddr(raw: unknown): string | null {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith("0x")) s = "0x" + s;
  return /^0x[0-9a-f]{16}$/.test(s) ? s : null;
}

// serial → nft_id fallback (moments authoritative, then sales) when the tracked
// row carries no nft_id. Delta rows come from special_serial_holders, which
// normally already has nft_id, so this is a rare fallback.
async function resolveTopShotNftId(editionId: string, serial: number): Promise<string | null> {
  const { data: m } = await supabase.from("moments")
    .select("nft_id").eq("edition_id", editionId).eq("serial_number", serial)
    .not("nft_id", "is", null).limit(1).maybeSingle();
  if (m?.nft_id) return String(m.nft_id);
  const { data: s } = await supabase.from("sales")
    .select("nft_id").eq("edition_id", editionId).eq("serial_number", serial)
    .not("nft_id", "is", null).order("sold_at", { ascending: false }).limit(1).maybeSingle();
  return s?.nft_id ? String(s.nft_id) : null;
}

// Path B: current owner via getMintedMoment(nft_id){owner{flowAddress}} through
// the topshot-proxy (server-side X-Proxy-Secret). See special-serial-sweep header.
async function lookupTopShotOwner(t: TrackedRow): Promise<OwnershipResult> {
  const nftId = t.nft_id ?? (await resolveTopShotNftId(t.edition_id, t.serial_number));
  if (!nftId) return { nft_id: null, holder_address: null };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/special-serial-delta",
  };
  if (TS_PROXY_SECRET) headers["X-Proxy-Secret"] = TS_PROXY_SECRET;
  const res = await fetch(TS_PROXY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: TS_GQL_OWNER_QUERY, variables: { id: nftId } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`topshot-proxy HTTP ${res.status}`);
  const json = await res.json() as any;
  const addr = toFlowAddr(json?.data?.getMintedMoment?.data?.owner?.flowAddress);
  return { nft_id: nftId, holder_address: addr };
}

async function resolveOwnership(t: TrackedRow): Promise<OwnershipResult> {
  switch (t.collection_id) {
    case COLLECTION_IDS.topshot:
      return lookupTopShotOwner(t);
    // AllDay / Golazos / UFC: deferred (Cadence resolvers, separate pass).
    default:
      return { nft_id: null, holder_address: null };
  }
}

async function fetchRecentlyTradedTracked(): Promise<TrackedRow[]> {
  // Tracked NFTs that traded in the last 24h. Filter Pinnacle out at the
  // SQL level. Joins editions for set/play/external_id we need to feed
  // the per-collection ownership lookups.
  //
  // The query is expressed via a small RPC stub — `get_recently_traded_special_serials`
  // — so we don't bake a complex join into the edge function. If that
  // RPC doesn't exist yet, fall back to a two-step JS join below.
  const { data, error } = await supabase.rpc("get_recently_traded_special_serials", { p_hours: 24 });
  if (!error && Array.isArray(data)) return data as TrackedRow[];

  // Fallback: walk special_serial_holders, hydrate edition info, intersect
  // with sales table within the last 24h. Pinnacle filtered out via
  // editions.collection_id.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: holders, error: hErr } = await supabase
    .from("special_serial_holders")
    .select("edition_id, badge_type, serial_number, nft_id");
  if (hErr || !holders || holders.length === 0) {
    if (hErr) console.log(`[delta] holders err ${hErr.message}`);
    return [];
  }
  const nftIds = holders.map((h: { nft_id: string | null }) => h.nft_id).filter((n: string | null): n is string => !!n);
  if (nftIds.length === 0) return [];

  const { data: sales, error: sErr } = await supabase
    // Parent `sales`, not a hardcoded year partition: the window is a rolling
    // now-24h, so `sales_2026` would silently stop matching once the date rolls
    // past 2026 (and miss cross-year trades near the boundary). Postgres prunes
    // to the right partition via the sold_at >= since predicate.
    .from("sales")
    .select("nft_id")
    .in("nft_id", nftIds)
    .gte("sold_at", since);
  if (sErr) {
    console.log(`[delta] sales err ${sErr.message}`);
    return [];
  }
  const tradedSet = new Set((sales ?? []).map((s: { nft_id: string | null }) => s.nft_id).filter((n: string | null): n is string => !!n));
  const tradedHolders = holders.filter((h: { nft_id: string | null }) => h.nft_id && tradedSet.has(h.nft_id));
  if (tradedHolders.length === 0) return [];

  const editionIds = Array.from(new Set(tradedHolders.map((h: { edition_id: string }) => h.edition_id)));
  const { data: editions, error: eErr } = await supabase
    .from("editions")
    .select("id, collection_id, set_id_onchain, play_id_onchain, external_id")
    .in("id", editionIds);
  if (eErr) {
    console.log(`[delta] editions err ${eErr.message}`);
    return [];
  }
  const edMap = new Map<string, { collection_id: string; set_id_onchain: number | null; play_id_onchain: number | null; external_id: string | null }>();
  for (const e of (editions ?? []) as Array<{ id: string; collection_id: string; set_id_onchain: number | null; play_id_onchain: number | null; external_id: string | null }>) {
    edMap.set(e.id, { collection_id: e.collection_id, set_id_onchain: e.set_id_onchain, play_id_onchain: e.play_id_onchain, external_id: e.external_id });
  }

  const out: TrackedRow[] = [];
  for (const h of tradedHolders as Array<{ edition_id: string; badge_type: string; serial_number: number; nft_id: string | null }>) {
    const e = edMap.get(h.edition_id);
    if (!e) continue;
    if (e.collection_id === COLLECTION_IDS.pinnacle) continue;
    out.push({
      edition_id: h.edition_id,
      badge_type: h.badge_type,
      serial_number: h.serial_number,
      nft_id: h.nft_id,
      collection_id: e.collection_id,
      set_id_onchain: e.set_id_onchain,
      play_id_onchain: e.play_id_onchain,
      external_id: e.external_id,
    });
  }
  return out;
}

async function upsertHolder(t: TrackedRow, result: OwnershipResult) {
  if (!result.holder_address) return;
  const { error } = await supabase
    .from("special_serial_holders")
    .upsert({
      edition_id: t.edition_id,
      badge_type: t.badge_type,
      serial_number: t.serial_number,
      nft_id: result.nft_id ?? t.nft_id,
      holder_address: result.holder_address.toLowerCase(),
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "edition_id,badge_type,serial_number" });
  if (error) console.log(`[delta] upsert err ${error.message} edition=${t.edition_id} serial=${t.serial_number}`);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  const tokenParam = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const startedAt = new Date().toISOString();
  let refreshed = 0;
  let scanned = 0;
  let failed = 0;

  try {
    const tracked = await fetchRecentlyTradedTracked();
    scanned = tracked.length;
    for (const t of tracked) {
      try {
        const result = await resolveOwnership(t);
        if (result.holder_address) {
          await upsertHolder(t, result);
          refreshed += 1;
        }
      } catch (err) {
        failed += 1;
        console.log(`[delta] err edition=${t.edition_id} serial=${t.serial_number}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(REQ_THROTTLE_MS);
    }
  } catch (err) {
    console.log(`[delta] fatal ${err instanceof Error ? err.message : String(err)}`);
  }

  return new Response(JSON.stringify({
    status: "ok",
    started_at: startedAt,
    scanned,
    refreshed,
    failed,
  }), { headers: { "Content-Type": "application/json" } });
});
