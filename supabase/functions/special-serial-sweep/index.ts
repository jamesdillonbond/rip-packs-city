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

// Path B (2026-07-05): resolve the CURRENT owner of a TopShot special serial via
// our serial→nft_id maps + Dapper getMintedMoment(nft_id){owner{flowAddress}}.
// Path A (searchMintedMoments by serial) stays dead — Dapper's op allowlist
// rejects it (verified 2026-06-15). getMintedMoment IS allowlisted and its
// MintedMoment payload exposes owner.flowAddress (verified 2026-07-05: nft
// 51748044 → owner f5d1b36f376ee7f3). No proxy-safelist change needed (the
// worker is a pure passthrough); the gate is Dapper's op allowlist, which
// getMintedMoment already passes. Serials we have never observed on-chain have
// no nft_id → unreachable via Path B (left for a future Path-C seeding pass;
// logged, never silently capped).

const TS_GQL_OWNER_QUERY = `query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{owner{flowAddress}}}}}`;

// serial → nft_id from our own maps (moments is authoritative for the pair;
// wmc/sales are fallbacks). editionId is the RPC edition_id (uuid).
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

function toFlowAddr(raw: unknown): string | null {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (!s.startsWith("0x")) s = "0x" + s;
  return /^0x[0-9a-f]{16}$/.test(s) ? s : null;
}

async function lookupTopShotOwner(editionId: string, serial: number): Promise<OwnershipResult> {
  const nftId = await resolveTopShotNftId(editionId, serial);
  if (!nftId) return { nft_id: null, holder_address: null };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/special-serial-sweep",
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
  // nft_id known but no owner (burned / GQL miss) → return nft_id, null holder
  // (upsertHolder early-returns on null holder, so nothing is written).
  return { nft_id: nftId, holder_address: addr };
}

// AllDay / Golazos / UFC ownership — Path B (our-denorm), mirroring the TopShot
// resolver above. Unlike TopShot (Dapper getMintedMoment exposes owner.flowAddress
// for any nft_id), RPC has no verified live per-NFT owner query wired for these
// three Dapper collections. Our authoritative current-owner source for them is
// wallet_moments_cache — the denorm the wallet-backfill Cadence walks populate,
// where edition_key === editions.external_id, moment_id === the on-chain nft id,
// and wallet_address is the current holder. Verified data path 2026-07-12:
// edition_key matches external_id on 99.98% of AllDay / 100% of Golazos+UFC wmc
// rows. Coverage of the special-serial TARGETS (#1 / perfect-mint / jersey-match)
// is bounded by backfill breadth — those serials sit mostly in un-walked wallets,
// so a target not present in wmc resolves to null (upsertHolder no-ops on a null
// holder) and is re-attempted as backfill widens. Reaching the un-walked / never-
// traded remainder needs a live per-collection Cadence/GQL owner lookup (Path A,
// future) — logged via the sweep's `unresolved` tally, never silently capped.
async function lookupOwnerFromWmc(
  collectionId: string,
  externalId: string | null,
  serial: number,
): Promise<OwnershipResult> {
  if (!externalId) return { nft_id: null, holder_address: null };
  const { data, error } = await supabase
    .from("wallet_moments_cache")
    .select("wallet_address, moment_id")
    .eq("collection_id", collectionId)
    .eq("edition_key", externalId)
    .eq("serial_number", serial)
    .not("wallet_address", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`wmc lookup: ${error.message}`);
  return {
    nft_id: data?.moment_id ? String(data.moment_id) : null,
    holder_address: toFlowAddr(data?.wallet_address),
  };
}

function lookupAllDayOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  return lookupOwnerFromWmc(COLLECTION_IDS.allday, externalId, serial);
}

function lookupGolazosOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  return lookupOwnerFromWmc(COLLECTION_IDS.golazos, externalId, serial);
}

function lookupUfcOwner(externalId: string | null, serial: number): Promise<OwnershipResult> {
  return lookupOwnerFromWmc(COLLECTION_IDS.ufc, externalId, serial);
}

async function resolveOwnership(target: TargetRow): Promise<OwnershipResult> {
  const ids = await lookupEditionIds(target.edition_id);
  switch (target.collection_id) {
    case COLLECTION_IDS.topshot:
      return lookupTopShotOwner(target.edition_id, target.serial_number);
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
  let unresolved = 0;
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
        } else {
          // Target had no reachable current owner (not in our denorm yet) — the
          // Path-A live-lookup remainder. Surfaced, never silently dropped.
          unresolved += 1;
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
  console.log(`[sweep] done collection=${collectionId} pages=${pages} processed=${processed} upserted=${upserted} unresolved=${unresolved} failed=${failed}`);
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
