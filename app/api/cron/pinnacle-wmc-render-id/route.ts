// app/api/cron/pinnacle-wmc-render-id/route.ts
//
// Keeps wallet_moments_cache Pinnacle rows resolved to their true per-pin
// render_id. New pins enter wmc via the wallet-backfill Cadence walk keyed on
// the set-level edition_key (which collapses distinct characters); this route
// fixes them by querying the Dapper studio-platform GraphQL by NFT id
// (= wmc.moment_id) for edition.render_id + serial + shape.name, then derives
// character/set/mint/image from pinnacle_catalog.
//
// Targets rows where render_id IS NULL (newly-acquired pins). The 2026-06-06
// bulk re-key was done by scripts/remap-pinnacle-wmc.mjs.
//
// Bearer auth on INGEST_SECRET_TOKEN. Cron: hourly (cron-job.org).
//
// 2026-06-10 (DBSAT residual fix): previously this ran fully synchronously and
// the FIRST thing it did was the candidate `.select(... limit 2000)`. Under
// connection-pool saturation that select hit the 8s authenticator
// statement_timeout and the route returned HTTP 500 BEFORE log_pipeline_run —
// so pipeline_runs went blind (no row since 09:37Z) even though the cron fired
// fine. It also did up to ~8 GQL chunks × 20s of work under a 60s maxDuration,
// overrunning cron-job.org's 30s client cap. Now: auth stays sync, we return
// 202 immediately, ALL work (incl. the candidate select) runs in after() with
// a wider maxDuration, and log_pipeline_run fires on EVERY path — including the
// candidate-query error path, where it logs the real PG error (mirrors the
// d4b058f fmv-recalc step3 observability pattern).

import { NextRequest, NextResponse, after } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
) as any;

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? "";
const PIPELINE_NAME = "pinnacle-wmc-render-id";
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714";
const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql";
const CAP = 2000;
const ID_CHUNK = 250;
// Ongoing sales render_id drain (Q2): keep new pinnacle_sales rows from sitting
// unresolved more than a tick. The one-time bulk drain is the admin route
// /api/admin/backfill-pinnacle-sales-render-id; this just chases the trickle.
const SALES_CAP = 1000;

const QUERY = `
query RemapByIds($ids: [UInt64!]!) {
  searchPinnacleNft(searchInput: { first: 250, filters: [{ id: { in: $ids } }] }) {
    edges { node { id serial_number edition { render_id } } }
  }
}`;

async function fetchByIds(ids: string[]): Promise<Array<{ id: string; serial: number | null; render_id: string | null }>> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://disneypinnacle.com",
      "User-Agent": "rip-packs-city/pinnacle-wmc-render-id",
    },
    body: JSON.stringify({ query: QUERY, variables: { ids } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GQL ${res.status}`);
  const json = (await res.json()) as { data?: { searchPinnacleNft?: { edges?: Array<{ node?: { id: string; serial_number: string | null; edition?: { render_id: string | null } } }> } }; errors?: unknown[] };
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error("GQL errors");
  return (json.data?.searchPinnacleNft?.edges ?? []).map((e) => ({
    id: e.node!.id,
    serial: e.node?.serial_number != null && Number(e.node.serial_number) > 0 ? Number(e.node.serial_number) : null,
    render_id: e.node?.edition?.render_id ?? null,
  }));
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tokenQuery = req.nextUrl.searchParams.get("token") ?? "";
  if (!TOKEN || (bearer !== TOKEN && tokenQuery !== TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  // Always emit exactly one pipeline_runs row, even on the candidate-query
  // failure path that used to return a dead 500.
  async function logRun(args: {
    ok: boolean;
    error: string | null;
    rowsFound: number;
    resolved: number;
    extra: Record<string, unknown>;
  }) {
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: args.rowsFound,
        p_rows_written: args.resolved,
        p_rows_skipped: 0,
        p_ok: args.ok,
        p_error: args.error,
        p_collection_slug: "disney_pinnacle",
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { ...args.extra, duration_ms: Date.now() - started },
      });
    } catch {
      // best-effort
    }
  }

  after(async () => {
    // Pull unresolved Pinnacle wmc rows (new pins). This is the statement that
    // timed out under saturation; now its failure is logged, not swallowed
    // into a 500.
    const { data: rows, error } = await supabaseAdmin
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("collection_id", PINNACLE_COLLECTION_ID)
      .is("render_id", null)
      .limit(CAP);
    if (error) {
      await logRun({
        ok: false,
        error: `candidate_read: ${error.message}`,
        rowsFound: 0,
        resolved: 0,
        extra: { stage: "candidate_read", saturation_suspect: true },
      });
      console.warn(`[${PIPELINE_NAME}] candidate read failed: ${error.message}`);
      return;
    }
    const ids = [...new Set((rows ?? []).map((r: { moment_id: string }) => r.moment_id))] as string[];

    let resolved = 0;
    let gqlErrors = 0;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      let nodes: Array<{ id: string; serial: number | null; render_id: string | null }> = [];
      try {
        nodes = await fetchByIds(chunk);
      } catch {
        gqlErrors++;
        continue;
      }
      for (const n of nodes) {
        if (!n.render_id) continue;
        await supabaseAdmin
          .from("wallet_moments_cache")
          .update({
            render_id: n.render_id,
            ...(n.serial != null ? { serial_number: n.serial } : {}),
          })
          .eq("collection_id", PINNACLE_COLLECTION_ID)
          .eq("moment_id", n.id)
          .is("render_id", null);
        resolved++;
      }
    }

    // Derive character/set/mint/image from the catalog for everything just resolved.
    let derived = 0;
    if (resolved > 0) {
      const { error: derErr } = await supabaseAdmin.rpc("derive_pinnacle_wmc_from_catalog");
      if (!derErr) derived = resolved;
    }

    // Q2 — drain a small batch of unresolved pinnacle_sales render_ids (same GQL path).
    let salesResolved = 0;
    let salesUpdated = 0;
    try {
      const { data: salesIdsData } = await supabaseAdmin.rpc(
        "pinnacle_sales_unresolved_render_nft_ids",
        { p_limit: SALES_CAP },
      );
      const salesIds = [...new Set(((salesIdsData ?? []) as string[]).filter(Boolean))];
      for (let i = 0; i < salesIds.length; i += ID_CHUNK) {
        const chunk = salesIds.slice(i, i + ID_CHUNK);
        let nodes: Array<{ id: string; serial: number | null; render_id: string | null }> = [];
        try {
          nodes = await fetchByIds(chunk);
        } catch {
          gqlErrors++;
          continue;
        }
        const map: Record<string, string> = {};
        for (const n of nodes) {
          if (n.render_id) map[n.id] = n.render_id;
        }
        const keys = Object.keys(map);
        if (keys.length === 0) continue;
        salesResolved += keys.length;
        const { data: cnt } = await supabaseAdmin.rpc("pinnacle_sales_set_render_ids", { p_map: map });
        salesUpdated += typeof cnt === "number" ? cnt : 0;
      }
    } catch {
      // best-effort — sales drain never fails the wmc pipeline
    }

    await logRun({
      ok: gqlErrors === 0,
      error: gqlErrors > 0 ? `${gqlErrors} gql chunk errors` : null,
      rowsFound: ids.length,
      resolved,
      extra: {
        unresolved_found: ids.length,
        resolved,
        derived,
        sales_resolved: salesResolved,
        sales_updated: salesUpdated,
        gql_errors: gqlErrors,
      },
    });
  });

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME, started_at: startedAtIso },
    { status: 202 },
  );
}
