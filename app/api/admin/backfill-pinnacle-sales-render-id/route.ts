// app/api/admin/backfill-pinnacle-sales-render-id/route.ts
//
// Drains pinnacle_sales rows whose render_id IS NULL (the per-pin key added inert
// by audit_20260606_pinnacle_sales_render_id_column). Resolves each NFT's render_id
// from the Dapper studio-platform GraphQL (searchPinnacleNft by id), then bulk-stamps
// pinnacle_sales via the set-based pinnacle_sales_set_render_ids RPC.
//
// Why this matters: 86% of Pinnacle sales sit on blended set-level legacy keys, so
// per-legacy-key FMV mixes different characters. render_id is the true per-pin spine
// (same one the catalog/wmc were re-keyed onto in 2e8cbd1). Once sales carry render_id,
// the FMV recompute can price per pin instead of per blended bucket.
//
// One-time bulk drain AND a cron-able ongoing drain. The hourly pinnacle-wmc-render-id
// cron also folds in a small sales drain so new sales never sit unresolved for long.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=). Methods: GET or POST.
// Query: ?limit=N caps distinct nft_ids resolved this run (default 6000).

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const PIPELINE_NAME = "pinnacle-sales-render-id-backfill";
const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const ID_CHUNK = 200;
const DEFAULT_LIMIT = 6000;
const PER_REQUEST_TIMEOUT_MS = 20_000;

const QUERY = `
query SalesRenderByIds($ids: [UInt64!]!) {
  searchPinnacleNft(searchInput: { first: 200, filters: [{ id: { in: $ids } }] }) {
    edges { node { id render_id edition { render_id } } }
  }
}`;

interface NftNode {
  id: string;
  render_id: string | null;
  edition: { render_id: string | null } | null;
}

async function fetchRenderIds(ids: string[]): Promise<Array<{ id: string; render_id: string }>> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-sales-render-id-backfill",
    },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = (await res.json()) as { data?: { searchPinnacleNft?: { edges?: Array<{ node?: NftNode }> } }; errors?: unknown[] };
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error("GQL errors");
  const out: Array<{ id: string; render_id: string }> = [];
  for (const e of json.data?.searchPinnacleNft?.edges ?? []) {
    const node = e.node;
    if (!node) continue;
    const renderId = node.render_id ?? node.edition?.render_id ?? null;
    if (renderId) out.push({ id: node.id, render_id: renderId });
  }
  return out;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const supabase: any = supabaseAdmin;

  const limitParam = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_LIMIT;

  let attempted = 0;
  let resolved = 0;
  let updated = 0;
  let gqlErrors = 0;
  const errors: string[] = [];

  try {
    const { data: idsData, error: idsErr } = await supabase.rpc(
      "pinnacle_sales_unresolved_render_nft_ids",
      { p_limit: limit },
    );
    if (idsErr) throw new Error(`unresolved ids rpc: ${idsErr.message}`);
    const ids: string[] = (idsData ?? []).filter(Boolean);
    attempted = ids.length;

    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      let nodes: Array<{ id: string; render_id: string }> = [];
      try {
        nodes = await fetchRenderIds(chunk);
      } catch (e) {
        gqlErrors++;
        if (errors.length < 3) errors.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (nodes.length === 0) continue;
      resolved += nodes.length;
      const map: Record<string, string> = {};
      for (const n of nodes) map[n.id] = n.render_id;
      const { data: cnt, error: setErr } = await supabase.rpc("pinnacle_sales_set_render_ids", {
        p_map: map,
      });
      if (setErr) {
        if (errors.length < 3) errors.push(`set rpc: ${setErr.message}`);
      } else {
        updated += typeof cnt === "number" ? cnt : 0;
      }
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  // Residual: distinct nft_ids still unresolved after this run (burned/edge NFTs the
  // GraphQL doesn't return stay NULL and are reported, not retried into a loop).
  let residual: number | null = null;
  try {
    const { data: rem } = await supabase.rpc("pinnacle_sales_unresolved_render_nft_ids", { p_limit: 100000 });
    residual = Array.isArray(rem) ? rem.length : null;
  } catch {
    // best-effort
  }

  const durationMs = Date.now() - startedAt;
  const ok = errors.length === 0;
  try {
    await supabase.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: attempted,
      p_rows_written: updated,
      p_rows_skipped: attempted - resolved,
      p_ok: ok,
      p_error: errors[0] ?? null,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        distinct_nft_attempted: attempted,
        nfts_resolved: resolved,
        sales_rows_updated: updated,
        distinct_nft_residual: residual,
        gql_errors: gqlErrors,
        duration_ms: durationMs,
        errors: errors.slice(0, 3),
      },
    });
  } catch {
    // best-effort observability
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    distinct_nft_attempted: attempted,
    nfts_resolved: resolved,
    sales_rows_updated: updated,
    distinct_nft_residual: residual,
    gql_errors: gqlErrors,
    duration_ms: durationMs,
    errors: errors.slice(0, 3),
  });
}

export async function GET(req: NextRequest) { return handle(req); }
export async function POST(req: NextRequest) { return handle(req); }
