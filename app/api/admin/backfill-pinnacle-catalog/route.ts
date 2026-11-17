// app/api/admin/backfill-pinnacle-catalog/route.ts
//
// Keeps public.pinnacle_catalog (render_id-keyed) fresh from the Dapper
// studio-platform GraphQL (api.production.studio-platform.dapperlabs.com),
// reachable unauthenticated from our egress with an Origin header. Pages
// searchPinnacleEditions and upserts every edition keyed on render_id — the
// true per-pin identity (the legacy pinnacle_editions.edition_key is set-level
// and collapses ~2,079 pins into ~337 rows).
//
// Auth: Bearer RPC_ADMIN_TOKEN (admin/cron-job.org, or ?token=) OR Bearer
// INGEST_SECRET_TOKEN (GitHub Actions) OR Bearer CRON_SECRET (Vercel cron).
// Methods: GET or POST.
// Crons: daily full backfill (cron-job.org) + intraday floor-only refresh
// (Vercel cron, ?floors_only=1 — keeps the public render floor fresh between
// daily runs). Initial bulk load was scripts/seed-pinnacle-catalog.mjs.

import { NextRequest, NextResponse, after as scheduleAfter } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";
import { bearerMatches } from "@/lib/auth/bearer-secret";
import { fetchChainCatalogRows } from "@/lib/pinnacle/chain-catalog";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const PIPELINE_NAME = "pinnacle-catalog-backfill";
const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const PAGE_SIZE = 100;
const PER_REQUEST_TIMEOUT_MS = 20_000;
// Renders read from the chain per run when the search lacks them (newest first).
const CHAIN_FILL_MAX = 60;

const QUERY = `
query CatalogBackfill($first: Int!, $after: String) {
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

function toArr(v: unknown): string[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.length ? [v] : null;
  return null;
}
function toInt(v: unknown): number | null {
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

interface Node {
  id: string; render_id: string | null; variant: string | null; printing: string | null;
  total_minted: string | null; chaser: boolean | null; parallel_type: string | null;
  edition_type: { name: string | null; limited_edition: boolean | null } | null;
  series: { name: string | null } | null;
  set: { name: string | null; render_id: string | null } | null;
  shape: { name: string | null; render_id: string | null; metadata: { royalty_codes: unknown; characters: unknown; franchises: unknown } | null } | null;
  metadata: { color: string | null; effects: string | null; materials: string | null; size: string | null; thickness: string | null } | null;
}

function buildRow(node: Node) {
  const renderId = node.render_id;
  if (!renderId) return null;
  const royaltyCodes = toArr(node.shape?.metadata?.royalty_codes);
  const royaltyCode = royaltyCodes?.[0] ?? null;
  const variant = node.variant ?? null;
  const printing = toInt(node.printing);
  const legacyKey =
    royaltyCode && variant != null && printing != null ? `${royaltyCode}:${variant}:${printing}` : null;
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
    // Image is served via the gate-free proxy route (signed-URL redirect).
    thumbnail_url: `/api/public/pinnacle-image/${renderId}`,
    front_anim_url: `https://assets.disneypinnacle.com/render/${renderId}/front_anim.webp`,
    source: "studio-platform-gql",
    updated_at: new Date().toISOString(),
  };
}

async function fetchPage(after: string | null) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-catalog-backfill",
    },
    body: JSON.stringify({ query: QUERY, variables: { first: PAGE_SIZE, after } }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = (await res.json()) as { data?: { searchPinnacleEditions?: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ node: Node }> } }; errors?: unknown[] };
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`GQL errors`);
  return json.data!.searchPinnacleEditions!;
}

// ── Floor-ask phase (item 3) ────────────────────────────────────────────────
// Pages all live listings (price asc), reducing to the per-render_id floor — the
// daily corroboration layer for the intraday listings-indexer. sortBy direction
// is an ENUM (ASC), not a string. listing.price is UFix64 (x 1e8).
const FLOOR_QUERY = `
query FloorAsks($first: Int!, $after: String) {
  searchPinnacleNft(searchInput: {
    first: $first, after: $after,
    filters: [{ listing: { price: { gte: 1 } } }],
    sortBy: { listing: { price: { priority: 1, direction: ASC } } }
  }) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node { id serial_number edition { render_id } listing { price } } }
  }
}`;

// `id` + `serial_number` added 2026-09-27: the same field names the production
// pinnacle-wmc-render-id cron reads off searchPinnacleNft. The sweep already
// visits every live listing; it now KEEPS them (pinnacle_live_listings) so the
// Sniper can read live listings instead of the dead Flowty feed.
interface FloorEdge { node?: { id?: string | null; serial_number?: string | null; edition?: { render_id: string | null } | null; listing?: { price: string | null } | null } }

async function fetchFloorPage(after: string | null) {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-catalog-backfill",
    },
    body: JSON.stringify({ query: FLOOR_QUERY, variables: { first: PAGE_SIZE, after } }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`floor GQL ${res.status}`);
  const json = (await res.json()) as { data?: { searchPinnacleNft?: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: FloorEdge[] } }; errors?: unknown[] };
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`floor GQL errors`);
  return json.data!.searchPinnacleNft!;
}

// Accept the admin token (Bearer or ?token=), the GitHub-Actions ingest token,
// or the Vercel-cron secret — mirrors the drain-topshot-misattribution route so
// the intraday floor refresh can be driven by a Vercel cron (which sends only
// Bearer CRON_SECRET). All three are equivalent-trust server secrets.
function authed(req: NextRequest): boolean {
  if (verifyAdminRequest(req)) return true;
  const header = req.headers.get("authorization") ?? "";
  const ingest = process.env.INGEST_SECRET_TOKEN;
  const cron = process.env.CRON_SECRET;
  if (ingest && bearerMatches(header, "INGEST_SECRET_TOKEN")) return true;
  if (cron && bearerMatches(header, "CRON_SECRET")) return true;
  return false;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authed(req)) return adminUnauthorizedResponse();

  // floors_only=1: skip the Phase-1 catalog metadata upsert and run ONLY the
  // Phase-2 render-floor sweep, so an intraday Vercel cron can keep the public
  // render floor (pinnacle_catalog.floor_ask) fresh without re-paging the whole
  // catalog. Same Studio-GraphQL source + same pinnacle_catalog_set_floor_asks
  // RPC as the daily run — a cadence change only, NOT a pricing-source/logic
  // change. The daily full backfill still owns catalog metadata.
  const floorsOnly = req.nextUrl.searchParams.get("floors_only") === "1";

  // 202 + after(): the catalog + floor sweep pages dozens of GQL calls
  // (maxDuration=120) and can exceed cron-job.org's 30s client cap; auth stays
  // sync, the whole sweep + log_pipeline_run move into after(), and we return
  // immediately so the entry can never be auto-disabled. pipeline_runs signals.
  scheduleAfter(async () => {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const supabase: any = supabaseAdmin;

  let after: string | null = null;
  let total = 0;
  let upserted = 0;
  let pages = 0;
  const errors: string[] = [];

  try {
    if (!floorsOnly) for (;;) {
      const res = await fetchPage(after);
      total = res.totalCount;
      const rows = res.edges.map((e) => buildRow(e.node)).filter(Boolean);
      if (rows.length > 0) {
        const { error } = await supabase
          .from("pinnacle_catalog")
          .upsert(rows, { onConflict: "render_id" });
        if (error) errors.push(error.message);
        else upserted += rows.length;
      }
      pages++;
      if (!res.pageInfo.hasNextPage) break;
      after = res.pageInfo.endCursor;
      if (pages > 100) break; // runaway guard (~10k editions)
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // ── Phase 1b (2026-11-08, handoff pinnacle-wmc-render-gap): is the SOURCE behind the chain? ──
  // A pin the chain minted whose render_id this search never returned has no catalog row, so its
  // name / set / image cannot be derived — and nothing said so. Compare against RPC's own mint
  // records after every full sweep: all-time gaps are reported; a RECENT gap (first minted within
  // 14 days) fails the run, because that is the source falling behind, not a standing orphan.
  let mintGap: { missing_renders?: number; missing_pins?: number; missing_recent_renders?: number; sample?: unknown[] } | null = null;
  let mintGapError: string | null = null;
  // Phase 1c (2026-11-09): a render the search lacks is read from the Pinnacle contract itself
  // (lib/pinnacle/chain-catalog.ts) and inserted FILL-ONLY, tagged source 'flow-chain'. Dapper's
  // row replaces it on the first sweep that returns it. The run fails only on what is STILL
  // missing after that — e.g. the chain read failed, or a render has no on-chain edition id.
  let chainFilled = 0;
  let chainFilledRecent = 0;
  let chainDerived = 0;
  const chainErrors: string[] = [];
  if (!floorsOnly) {
    try {
      const { data: gap, error: gapErr } = await supabase.rpc("pinnacle_minted_renders_missing_from_catalog", { p_sample: CHAIN_FILL_MAX, p_recent_days: 14 });
      if (gapErr) mintGapError = gapErr.message;
      else mintGap = gap && typeof gap === "object" ? gap : null;
    } catch (e) {
      mintGapError = e instanceof Error ? e.message : String(e);
    }
    const missingSample = (Array.isArray(mintGap?.sample) ? mintGap!.sample : []) as Array<{ render_id?: string; first_minted_at?: string }>;
    if (!mintGapError && missingSample.length > 0) {
      try {
        const editionByRender = new Map<string, number>();
        const renderIds = missingSample.map((s) => s.render_id).filter((r): r is string => !!r);
        for (let i = 0; i < renderIds.length; i += 10) {
          await Promise.all(
            renderIds.slice(i, i + 10).map(async (rid) => {
              const { data, error } = await supabase
                .from("pinnacle_mint_events")
                .select("edition_id")
                .eq("render_id", rid)
                .not("edition_id", "is", null)
                .limit(1)
                .maybeSingle();
              if (error) chainErrors.push(`edition id for ${rid}: ${error.message}`);
              const ed = Number((data as { edition_id?: unknown } | null)?.edition_id);
              if (Number.isInteger(ed) && ed > 0) editionByRender.set(rid, ed);
            }),
          );
        }
        if (editionByRender.size > 0) {
          const { rows: chainRows, errors: readErrors } = await fetchChainCatalogRows([...editionByRender.values()]);
          chainErrors.push(...readErrors);
          // Only rows for renders that were actually missing — never a render the search already wrote.
          const wanted = chainRows.filter((r) => editionByRender.has(r.render_id));
          if (wanted.length > 0) {
            const { data: ins, error: insErr } = await supabase
              .from("pinnacle_catalog")
              .upsert(wanted, { onConflict: "render_id", ignoreDuplicates: true })
              .select("render_id");
            if (insErr) chainErrors.push(`chain rows insert: ${insErr.message}`);
            else {
              const filled = new Set(((ins as Array<{ render_id: string }> | null) ?? []).map((r) => r.render_id));
              chainFilled = filled.size;
              const recentCut = Date.now() - 14 * 86_400_000;
              chainFilledRecent = missingSample.filter(
                (s) => s.render_id && filled.has(s.render_id) && s.first_minted_at && Date.parse(s.first_minted_at) > recentCut,
              ).length;
            }
          }
        }
      } catch (e) {
        chainErrors.push(e instanceof Error ? e.message : String(e));
      }
      if (chainFilled > 0) {
        console.warn(`[${PIPELINE_NAME}] filled ${chainFilled} catalog row(s) from the chain`);
        // Name the wallet pins now. The wmc render-id lane derives only in an hour that resolved
        // NEW render ids, so pins whose render_id landed BEFORE their catalog row existed (the
        // whole 11-08 drop: 961 rows) were never re-derived. The derive is fill/refresh-only.
        try {
          const { data: der, error: derErr } = await supabase.rpc("derive_pinnacle_wmc_from_catalog");
          if (derErr) chainErrors.push(`wmc derive: ${derErr.message}`);
          else chainDerived = typeof der === "number" ? der : 0;
        } catch (e) {
          chainErrors.push(`wmc derive: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const recentStillMissing = Math.max(0, Number(mintGap?.missing_recent_renders ?? 0) - chainFilledRecent);
    if (mintGapError) errors.push(`mint gap check: ${mintGapError}`);
    else if (mintGap && recentStillMissing > 0) {
      errors.push(
        `catalog behind mints: ${recentStillMissing} render(s) minted in the last 14 days have no catalog row (${mintGap.missing_renders} all-time, ${mintGap.missing_pins} pins; ${chainFilled} filled from chain${chainErrors.length ? `; chain: ${chainErrors[0]}` : ""})`,
      );
    }
    if (mintGap && Number(mintGap.missing_renders ?? 0) > 0) {
      console.warn(`[${PIPELINE_NAME}] ${mintGap.missing_renders} minted render(s) not in the catalog (${mintGap.missing_recent_renders} recent)`);
    }
  }

  // ── Phase 2: floor-ask sweep (best-effort; failures don't fail the catalog) ──
  let floorListed = 0;     // distinct render_ids with a live floor
  let floorRows = 0;       // catalog rows updated (= editions with a floor)
  let floorPages = 0;
  let floorTotal = 0;
  let floorComplete = false;
  let liveWritten = 0;
  let liveDeleted = 0;
  const liveListings: Array<{ nft_id: string; render_id: string; serial_number: number | null; price_usd: number }> = [];
  try {
    const floorByRender = new Map<string, number>(); // first-seen wins (price asc)
    let fAfter: string | null = null;
    for (;;) {
      const res = await fetchFloorPage(fAfter);
      floorTotal = res.totalCount;
      for (const e of res.edges) {
        const rid = e.node?.edition?.render_id ?? null;
        const price = e.node?.listing?.price ?? null;
        if (rid && price != null && !floorByRender.has(rid)) {
          const n = Number(price);
          if (Number.isFinite(n) && n > 0) floorByRender.set(rid, n);
        }
        const nftId = e.node?.id ?? null;
        // ⚠ `listing.price` is RAW UFix64 (× 1e8) — pinnacle_catalog_set_floor_asks
        // divides the floor map by 1e8 in SQL. The live-listing rows store DOLLARS,
        // so divide here. (First shipped without it, 2026-09-27: every listing read
        // 1e8× its price and the Sniper found 0 deals in 16,116 listings.)
        const p = price != null ? Number(price) / 1e8 : NaN;
        if (rid && nftId && Number.isFinite(p) && p > 0) {
          const serial = e.node?.serial_number != null ? Number(e.node.serial_number) : NaN;
          liveListings.push({ nft_id: String(nftId), render_id: rid, serial_number: Number.isInteger(serial) ? serial : null, price_usd: p });
        }
      }
      floorPages++;
      if (!res.pageInfo.hasNextPage) { floorComplete = true; break; }
      fAfter = res.pageInfo.endCursor;
      // Runaway guard. Was 200 pages (~20k listings) while the market already sat
      // at ~16.1k (161 pages, 2026-09-27) — raised so growth does not silently
      // truncate the sweep. A guard exit leaves floorComplete=false.
      if (floorPages > 400) break;
    }
    floorListed = floorByRender.size;
    if (floorListed > 0) {
      const map = Object.fromEntries(floorByRender);
      const { data: cnt, error: floorErr } = await supabase.rpc("pinnacle_catalog_set_floor_asks", {
        p_map: map,
        p_checked_at: startedAtIso,
      });
      if (floorErr) errors.push(`floor set: ${floorErr.message}`);
      else floorRows = typeof cnt === "number" ? cnt : 0;
    }
    // The live-listing set is REPLACED only from a COMPLETE sweep: a partial one
    // would retire listings it simply never reached (CLAUDE.md, R123). The RPC
    // upserts first and deletes only what this sweep did not write.
    if (floorComplete && liveListings.length > 0) {
      const { data: live, error: liveErr } = await supabase.rpc("pinnacle_live_listings_replace", {
        p_rows: liveListings,
        p_seen_at: startedAtIso,
      });
      if (liveErr) errors.push(`live listings: ${liveErr.message}`);
      else {
        liveWritten = Number(live?.written ?? 0);
        liveDeleted = Number(live?.deleted ?? 0);
      }
    } else if (!floorComplete) {
      errors.push(`live listings: sweep incomplete after ${floorPages} pages — live set left as it was`);
    }
  } catch (e) {
    errors.push(`floor phase: ${e instanceof Error ? e.message : String(e)}`);
  }

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: floorsOnly ? "pinnacle-catalog-floor-refresh" : PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: total,
      p_rows_written: floorsOnly ? floorRows : upserted,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errors[0] ?? null,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { floors_only: floorsOnly, pages, total_count: total, upserted, floor_listed: floorListed, floor_rows: floorRows, floor_pages: floorPages, floor_total: floorTotal, floor_complete: floorComplete, live_listings_seen: liveListings.length, live_written: liveWritten, live_deleted: liveDeleted, minted_renders_missing: mintGap?.missing_renders ?? null, minted_pins_missing: mintGap?.missing_pins ?? null, minted_renders_missing_recent: mintGap?.missing_recent_renders ?? null, minted_missing_sample: Array.isArray(mintGap?.sample) ? mintGap!.sample.slice(0, 10) : null, mint_gap_error: mintGapError, chain_filled: chainFilled, chain_filled_recent: chainFilledRecent, chain_wmc_derived: chainDerived, chain_errors: chainErrors.slice(0, 3), duration_ms: durationMs, errors: errors.slice(0, 3) },
    });
  } catch {
    // best-effort observability
  }

  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: floorsOnly ? "pinnacle-catalog-floor-refresh" : PIPELINE_NAME, floors_only: floorsOnly },
    { status: 202 }
  );
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
