// app/api/admin/apply-fmv-haircut/route.ts
//
// POST — wraps the public.fmv_apply_thin_sale_haircut RPC.
//
// Modes:
//   ?mode=dry   → SELECT * FROM fmv_apply_thin_sale_haircut(p_collection_id, true)
//                 (preview, no writes)
//   ?mode=live  → SELECT * FROM fmv_apply_thin_sale_haircut(p_collection_id, false)
//                 (applies the haircut)
//
// Optional ?collection=topshot|allday|golazos|ufc|pinnacle resolves to the
// collection UUID; omit to scope across every collection (NULL).
//
// The RPC itself filters to LOW + ASK_ONLY confidence — HIGH/MEDIUM are
// untouched. Returns rows_examined / rows_haircut / total_dollars_removed.
//
// Auth: Bearer RPC_ADMIN_TOKEN (or ?token=) via verifyAdminRequest.

import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// CLAUDE.md infra block — long-form vocabulary keyed by the short-form
// query-param tokens callers will pass.
const COLLECTION_UUID: Record<string, string> = {
  topshot: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  allday: "dee28451-5d62-409e-a1ad-a83f763ac070",
  golazos: "06248cc4-b85f-47cd-af67-1855d14acd75",
  ufc: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  pinnacle: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
};

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse();

  const mode = (req.nextUrl.searchParams.get("mode") ?? "").toLowerCase();
  if (mode !== "dry" && mode !== "live") {
    return NextResponse.json(
      { error: "mode query param must be 'dry' or 'live'" },
      { status: 400 }
    );
  }

  const collectionParam = req.nextUrl.searchParams.get("collection");
  let collectionId: string | null = null;
  if (collectionParam) {
    const key = collectionParam.toLowerCase();
    if (!(key in COLLECTION_UUID)) {
      return NextResponse.json(
        {
          error: `unknown collection '${collectionParam}'. Valid: ${Object.keys(
            COLLECTION_UUID
          ).join(", ")}`,
        },
        { status: 400 }
      );
    }
    collectionId = COLLECTION_UUID[key];
  }

  // Dry-run is an interactive preview the operator reads — keep it synchronous
  // so the response carries rows_examined / rows_haircut / total_dollars_removed.
  if (mode === "dry") {
    const startedAt = Date.now();
    const { data, error } = await supabaseAdmin.rpc("fmv_apply_thin_sale_haircut", {
      p_collection_id: collectionId,
      p_dry_run: true,
    });
    if (error) {
      console.error(
        `[apply-fmv-haircut] mode=dry collection=${collectionParam ?? "all"} error: ${error.message}`
      );
      return NextResponse.json(
        { error: error.message, mode, collection: collectionParam ?? null },
        { status: 500 }
      );
    }
    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    return NextResponse.json({
      mode,
      collection: collectionParam ?? null,
      rows_examined: row?.rows_examined ?? 0,
      rows_haircut: row?.rows_haircut ?? 0,
      total_dollars_removed: row?.total_dollars_removed ?? 0,
      duration_ms: Date.now() - startedAt,
    });
  }

  // Live mode is the daily cron (06:30 UTC) and can exceed cron-job.org's 30s
  // client cap. 202 + after(): auth + validation already ran synchronously; the
  // write + log_pipeline_run run in after() and pipeline_runs is the real signal.
  const startedAtIso = new Date().toISOString();
  after(async () => {
    const startedAt = Date.now();
    // 2026-06-11: the haircut RPC previously sat OUTSIDE a try/catch, so a THROW
    // (pool timeout under saturation, not a returned error) rejected the after()
    // before any log_pipeline_run — a silent run while cron-job.org acked green.
    // Capture the thrown case alongside the existing returned-error path.
    let data: any = null;
    let error: { message: string } | null = null;
    try {
      const res = await supabaseAdmin.rpc("fmv_apply_thin_sale_haircut", {
        p_collection_id: collectionId,
        p_dry_run: false,
      });
      data = res.data;
      error = res.error;
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e) };
    }

    if (error) {
      console.error(
        `[apply-fmv-haircut] mode=live collection=${collectionParam ?? "all"} error: ${error.message}`
      );
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: "apply-fmv-haircut",
          p_started_at: startedAtIso,
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: error.message,
          p_collection_slug: collectionParam ?? null,
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: { mode, total_dollars_removed: 0 },
        });
      } catch (logErr) {
        console.warn(
          `[apply-fmv-haircut] log_pipeline_run err: ${
            logErr instanceof Error ? logErr.message : String(logErr)
          }`
        );
      }
      return;
    }

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const durationMs = Date.now() - startedAt;
    const rowsExamined = Number(row?.rows_examined ?? 0);
    const rowsHaircut = Number(row?.rows_haircut ?? 0);
    const totalDollarsRemoved = Number(row?.total_dollars_removed ?? 0);

    console.log(
      `[apply-fmv-haircut] mode=live collection=${collectionParam ?? "all"} examined=${rowsExamined} haircut=${rowsHaircut} dollars_removed=${totalDollarsRemoved} duration_ms=${durationMs}`
    );

    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "apply-fmv-haircut",
        p_started_at: startedAtIso,
        p_rows_found: rowsExamined,
        p_rows_written: rowsHaircut,
        p_rows_skipped: Math.max(0, rowsExamined - rowsHaircut),
        p_ok: true,
        p_error: null,
        p_collection_slug: collectionParam ?? null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: { mode, total_dollars_removed: totalDollarsRemoved },
      });
    } catch (logErr) {
      console.warn(
        `[apply-fmv-haircut] log_pipeline_run err: ${
          logErr instanceof Error ? logErr.message : String(logErr)
        }`
      );
    }
  });

  return NextResponse.json(
    { ok: true, accepted: true, pipeline: "apply-fmv-haircut", mode, collection: collectionParam ?? null },
    { status: 202 }
  );
}
