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

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const PIPELINE_NAME = "pinnacle-catalog-backfill";
const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const PAGE_SIZE = 100;
const PER_REQUEST_TIMEOUT_MS = 20_000;

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
    edges { node { edition { render_id } listing { price } } }
  }
}`;

interface FloorEdge { node?: { edition?: { render_id: string | null } | null; listing?: { price: string | null } | null } }

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
  if (ingest && header === `Bearer ${ingest}`) return true;
  if (cron && header === `Bearer ${cron}`) return true;
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

  // ── Phase 2: floor-ask sweep (best-effort; failures don't fail the catalog) ──
  let floorListed = 0;     // distinct render_ids with a live floor
  let floorRows = 0;       // catalog rows updated (= editions with a floor)
  let floorPages = 0;
  let floorTotal = 0;
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
      }
      floorPages++;
      if (!res.pageInfo.hasNextPage) break;
      fAfter = res.pageInfo.endCursor;
      if (floorPages > 200) break; // runaway guard (~20k listings)
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
      p_extra: { floors_only: floorsOnly, pages, total_count: total, upserted, floor_listed: floorListed, floor_rows: floorRows, floor_pages: floorPages, floor_total: floorTotal, duration_ms: durationMs, errors: errors.slice(0, 3) },
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
