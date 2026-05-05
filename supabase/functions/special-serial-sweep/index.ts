// supabase/functions/special-serial-sweep/index.ts
// Phase 1H. Backfill ownership for #1 / jersey-match / perfect-mint serials
// across the four non-Pinnacle collections. Pinnacle is excluded — its
// ownership mechanic is a separate workstream.
//
// Trigger: ad-hoc via curl. Not on a cron — re-run when new editions are
// added or when the work queue grows. Returns 202 immediately and processes
// the queue asynchronously via EdgeRuntime.waitUntil().
//
// Auth: Authorization header must contain INGEST_SECRET_TOKEN (or pass it
// as ?token=<value>). Same pattern as seed-allday-pack-distributions.
//
// Input body (all optional):
//   { collection_id?: string, force_refresh?: boolean, batch_size?: number }
//
// Idempotency: writes go through INSERT … ON CONFLICT (edition_id, badge_type,
// serial_number) DO UPDATE so re-runs are safe.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN");
if (!INGEST_TOKEN) throw new Error("INGEST_SECRET_TOKEN is required");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev/topshot";
const ALLDAY_PROXY_URL = Deno.env.get("ALLDAY_PROXY_URL") ?? "https://topshot-proxy.tdillonbond.workers.dev/allday";
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? "";

const REQ_THROTTLE_MS = 50;     // ~20 req/s ceiling.
const DEFAULT_BATCH_SIZE = 200;
const MAX_PAGES_PER_RUN = 1000; // safety cap (200 × 1000 = 200k targets)

const COLLECTION_IDS = {
  topshot:  "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday:   "dee28451-5d62-409e-a1ad-a83f763ac070",
  golazos:  "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc:      "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
} as const;

const NON_PINNACLE_COLLECTION_IDS = [
  COLLECTION_IDS.topshot,
  COLLECTION_IDS.allday,
  COLLECTION_IDS.golazos,
  COLLECTION_IDS.ufc,
];

interface TargetRow {
  collection_id: string;
  edition_id: string;
  badge_type: string; // 'first_serial' | 'perfect_mint' (jersey_match handled by separate queue path)
  serial_number: number;
}

interface OwnershipResult {
  nft_id: string | null;
  holder_address: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Edition lookup helper ───────────────────────────────────────────────────
// Resolve set_id_onchain / play_id_onchain (used by GQL ownership lookups)
// for a given edition_id. Cached in-memory per invocation to avoid hammering
// the editions table.

const editionCache = new Map<string, { set_id_onchain: number | null; play_id_onchain: number | null; external_id: string | null } | null>();

async function lookupEditionIds(editionId: string) {
  if (editionCache.has(editionId)) return editionCache.get(editionId)!;
  const { data, error } = await supabase
    .from("editions")
    .select("set_id_onchain, play_id_onchain, external_id")
    .eq("id", editionId)
    .maybeSingle();
  if (error || !data) {
    editionCache.set(editionId, null);
    return null;
  }
  const v = {
    set_id_onchain: data.set_id_onchain ?? null,
    play_id_onchain: data.play_id_onchain ?? null,
    external_id: data.external_id ?? null,
  };
  editionCache.set(editionId, v);
  return v;
}

// ── Per-collection ownership lookups ────────────────────────────────────────
//
// IMPORTANT: each resolver below is responsible for translating
// (collection, edition, serial) → (nft_id, holder_address). The exact
// query / Cadence-script shape per collection is captured inline. These
// resolvers mirror the patterns used in lib/editions-hydrate.ts and the
// existing app/api/sniper-feed and app/api/topshot-listing-cache routes —
// keep the X-Proxy-Secret header naming, query operation names, and field
// paths consistent or the proxy worker / safelist will reject them.
//
// AllDay/UFC Cadence quirks (validated 2026-04 — see CLAUDE.md):
//   - AllDay: do NOT use borrowMomentNFT; use borrowNFT(id)! cast to
//     &AllDay.NFT, then chain getEditionData → getPlayData → metadata.
//   - UFC:   no UFC_NFT.MomentNFTCollectionPublic; import only the
//     CollectionPublicPath and borrow as NonFungibleToken.CollectionPublic.

async function lookupTopShotOwner(setId: number | null, playId: number | null, serial: number): Promise<OwnershipResult> {
  if (setId === null || playId === null) return { nft_id: null, holder_address: null };
  // STUB: shape the GQL call against the topshot-proxy worker. Mirror the
  // searchMintedMoments pattern used in app/api/sniper-feed; that path
  // returns the moment id + owner.flowAddress for a (setID, playID, serial)
  // triple. Wire it up with the existing safelisted operationName when
  // ready — left as a no-op resolver here so the queue scaffold is safe
  // to deploy without partial / wrong data.
  void TS_PROXY_URL; void TS_PROXY_SECRET;
  console.log(`[sweep:topshot] TODO ownership lookup setID=${setId} playID=${playId} serial=${serial}`);
  return { nft_id: null, holder_address: null };
}

async function lookupAllDayOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  if (!externalId) return { nft_id: null, holder_address: null };
  void ALLDAY_PROXY_URL;
  console.log(`[sweep:allday] TODO ownership lookup external_id=${externalId} serial=${serial}`);
  return { nft_id: null, holder_address: null };
}

async function lookupGolazosOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  if (!externalId) return { nft_id: null, holder_address: null };
  console.log(`[sweep:golazos] TODO ownership lookup external_id=${externalId} serial=${serial}`);
  return { nft_id: null, holder_address: null };
}

async function lookupUfcOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  if (!externalId) return { nft_id: null, holder_address: null };
  console.log(`[sweep:ufc] TODO ownership lookup external_id=${externalId} serial=${serial}`);
  return { nft_id: null, holder_address: null };
}

async function resolveOwnership(target: TargetRow): Promise<OwnershipResult> {
  const ids = await lookupEditionIds(target.edition_id);
  switch (target.collection_id) {
    case COLLECTION_IDS.topshot:
      return lookupTopShotOwner(ids?.set_id_onchain ?? null, ids?.play_id_onchain ?? null, target.serial_number);
    case COLLECTION_IDS.allday:
      return lookupAllDayOwner(ids?.external_id ?? null, target.serial_number);
    case COLLECTION_IDS.golazos:
      return lookupGolazosOwner(ids?.external_id ?? null, target.serial_number);
    case COLLECTION_IDS.ufc:
      return lookupUfcOwner(ids?.external_id ?? null, target.serial_number);
    default:
      return { nft_id: null, holder_address: null };
  }
}

// ── Idempotent upsert ───────────────────────────────────────────────────────

async function upsertHolder(target: TargetRow, result: OwnershipResult) {
  if (!result.holder_address) return;
  const { error } = await supabase
    .from("special_serial_holders")
    .upsert({
      edition_id: target.edition_id,
      badge_type: target.badge_type,
      serial_number: target.serial_number,
      nft_id: result.nft_id,
      holder_address: result.holder_address.toLowerCase(),
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "edition_id,badge_type,serial_number" });
  if (error) console.log(`[sweep] upsert err ${error.message} for edition=${target.edition_id} serial=${target.serial_number}`);
}

// ── Sweep loop ──────────────────────────────────────────────────────────────

async function sweepCollection(collectionId: string, batchSize: number, forceRefresh: boolean) {
  let offset = 0;
  let pages = 0;
  let processed = 0;
  let upserted = 0;
  let failed = 0;
  while (pages < MAX_PAGES_PER_RUN) {
    const { data, error } = await supabase.rpc("get_special_serial_targets", {
      p_collection_id: collectionId,
      p_limit: batchSize,
      p_offset: offset,
      p_force_refresh: forceRefresh,
    });
    if (error) {
      console.log(`[sweep] rpc err ${error.message} collection=${collectionId}`);
      break;
    }
    const targets = (data ?? []) as TargetRow[];
    if (targets.length === 0) break;
    pages += 1;

    for (const t of targets) {
      try {
        const result = await resolveOwnership(t);
        if (result.holder_address) {
          await upsertHolder(t, result);
          upserted += 1;
        }
      } catch (err) {
        failed += 1;
        console.log(`[sweep] err edition=${t.edition_id} serial=${t.serial_number}: ${err instanceof Error ? err.message : String(err)}`);
      }
      processed += 1;
      await sleep(REQ_THROTTLE_MS);
    }
    if (targets.length < batchSize) break;
    offset += batchSize;
  }
  console.log(`[sweep] done collection=${collectionId} pages=${pages} processed=${processed} upserted=${upserted} failed=${failed}`);
}

async function runSweep(collectionId: string | null, batchSize: number, forceRefresh: boolean) {
  const list = collectionId ? [collectionId] : NON_PINNACLE_COLLECTION_IDS;
  for (const c of list) {
    if (c === COLLECTION_IDS.pinnacle) continue;
    await sweepCollection(c, batchSize, forceRefresh);
  }
}

// ── HTTP handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const auth = req.headers.get("Authorization") ?? "";
  const tokenParam = url.searchParams.get("token") ?? "";
  if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let body: { collection_id?: string; force_refresh?: boolean; batch_size?: number } = {};
  if (req.method === "POST") {
    try { body = await req.json(); } catch { /* empty body is fine */ }
  }

  const collectionId = body.collection_id ?? null;
  if (collectionId && collectionId === COLLECTION_IDS.pinnacle) {
    return new Response(JSON.stringify({ error: "Pinnacle is excluded from special-serial sweep" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const batchSize = clampInt(body.batch_size ?? DEFAULT_BATCH_SIZE, 1, 1000);
  const forceRefresh = body.force_refresh === true;
  const startedAt = new Date().toISOString();

  const work = (async () => {
    try { await runSweep(collectionId, batchSize, forceRefresh); }
    catch (err) { console.log(`[sweep] fatal: ${err instanceof Error ? err.message : String(err)}`); }
  })();

  // Edge runtime async dispatch — keep the function alive past the response.
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er && typeof er.waitUntil === "function") er.waitUntil(work);
  else await work;

  return new Response(JSON.stringify({
    status: "accepted",
    collection_id: collectionId ?? "all",
    batch_size: batchSize,
    force_refresh: forceRefresh,
    started_at: startedAt,
  }), { status: 202, headers: { "Content-Type": "application/json" } });
});

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
