// app/api/admin/backfill-pinnacle-catalog/route.ts
//
// Keeps public.pinnacle_catalog (render_id-keyed) fresh from the Dapper
// studio-platform GraphQL (api.production.studio-platform.dapperlabs.com),
// reachable unauthenticated from our egress with an Origin header. Pages
// searchPinnacleEditions and upserts every edition keyed on render_id — the
// true per-pin identity (the legacy pinnacle_editions.edition_key is set-level
// and collapses ~2,079 pins into ~337 rows).
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=). Methods: GET or POST.
// Cron: daily (cron-job.org). Initial bulk load was scripts/seed-pinnacle-catalog.mjs.

import { NextRequest, NextResponse } from "next/server";
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

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const supabase: any = supabaseAdmin;

  let after: string | null = null;
  let total = 0;
  let upserted = 0;
  let pages = 0;
  const errors: string[] = [];

  try {
    for (;;) {
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

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: total,
      p_rows_written: upserted,
      p_rows_skipped: 0,
      p_ok: ok,
      p_error: errors[0] ?? null,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { pages, total_count: total, upserted, duration_ms: durationMs, errors: errors.slice(0, 3) },
    });
  } catch {
    // best-effort observability
  }

  return NextResponse.json({ ok, pipeline: PIPELINE_NAME, total_count: total, upserted, pages, duration_ms: durationMs, errors: errors.slice(0, 3) });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
