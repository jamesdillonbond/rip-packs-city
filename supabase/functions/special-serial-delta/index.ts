// supabase/functions/special-serial-delta/index.ts
// Phase 1H. Daily refresh of ownership for tracked NFTs that traded in the
// last 24 hours. Cron-scheduled every 30 minutes via cron-job.org targeting
// this function URL with the INGEST_SECRET_TOKEN bearer header.
//
// Result set is small (typically a handful of trades per day), so this runs
// inline and returns the count when done — no async dispatch needed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

async function lookupTopShotOwner(_setId: number | null, _playId: number | null, _serial: number): Promise<OwnershipResult> {
  return { nft_id: null, holder_address: null };
}
async function lookupAllDayOwner(_externalId: string | null, _serial: number): Promise<OwnershipResult> {
  return { nft_id: null, holder_address: null };
}
async function lookupGolazosOwner(_externalId: string | null, _serial: number): Promise<OwnershipResult> {
  return { nft_id: null, holder_address: null };
}
async function lookupUfcOwner(_externalId: string | null, _serial: number): Promise<OwnershipResult> {
  return { nft_id: null, holder_address: null };
}

async function resolveOwnership(t: TrackedRow): Promise<OwnershipResult> {
  switch (t.collection_id) {
    case COLLECTION_IDS.topshot:
      return lookupTopShotOwner(t.set_id_onchain, t.play_id_onchain, t.serial_number);
    case COLLECTION_IDS.allday:
      return lookupAllDayOwner(t.external_id, t.serial_number);
    case COLLECTION_IDS.golazos:
      return lookupGolazosOwner(t.external_id, t.serial_number);
    case COLLECTION_IDS.ufc:
      return lookupUfcOwner(t.external_id, t.serial_number);
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
    .from("sales_2026")
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
