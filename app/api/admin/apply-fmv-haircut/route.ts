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

    // ── PER-COLLECTION SPLIT (2026-08-16) ────────────────────────────────────
    // The un-scoped call (p_collection_id NULL = every collection in ONE
    // statement) failed 100% of its daily runs from at least 2026-08-14, each
    // at ~125.17s. That is the global `statement_timeout` of 120s plus the
    // documented overshoot under IO throttle — NOT this route's maxDuration of
    // 300s, and NOT the RPC's own declared `statement_timeout=300s`, which is
    // INERT (a function-level SET does not bind the statements inside it; see
    // the 195-function inert-timeout population). So no clock available here
    // can fix it: the lever is the WORK.
    //
    // The cost is `SELECT DISTINCT ON (edition_id) * FROM fmv_snapshots` over
    // ~1.15M rows, whose collection filter is the non-sargable
    // `(p_collection_id IS NULL OR collection_id = p_collection_id)`. Splitting
    // by collection gives each leg its OWN 120s budget. Measured share of
    // fmv_snapshots: topshot 67.3%, allday 31.2%, golazos 0.9%, ufc 0.3%,
    // candy_mlb 0.2% — so the four small legs become trivial and finish, where
    // today a single over-budget statement discards all five.
    //
    // ⚠ This is output-identical to the un-scoped call, not a policy change:
    // the RPC, its haircut predicate and its confidence gate are untouched, and
    // the union of per-collection runs covers exactly the same rows. What DOES
    // change is that a failure is now PARTIAL — the collections that fit still
    // get their haircut instead of being discarded alongside the one that
    // didn't.
    //
    // ⚠ The list is derived from `collections`, NOT from COLLECTION_UUID above.
    // That map omits `candy_mlb` (2,815 live snapshots) and includes `pinnacle`
    // (ZERO — Pinnacle FMV lives in pinnacle_fmv_history, not fmv_snapshots), so
    // splitting on it would have silently dropped Candy from the haircut while
    // looking complete. A hardcoded member list is exactly what goes stale when
    // a collection is added.
    //
    // ⛔ MEASURED 2026-08-23: the Top Shot leg does NOT fit, and the estimate
    // above was wrong in both directions. In a genuinely quiet window
    // (io_wait 8 / active 9) the read half ALONE ran 101,425 ms and touched
    // 800,545 buffers (~6.25 GB) — walking 850,490 index entries down to
    // 19,667 editions to find FOURTEEN rows. This function runs that
    // DISTINCT ON twice (measurement CTE + the UPDATE ... FROM latest), so the
    // leg is ~200s of work. It has failed every run since the split.
    //
    // ⚠ AND THE BOUND NAMED ABOVE IS THE WRONG ONE. The observed error is
    // `upstream request timeout`, which is the SUPABASE GATEWAY (~120s), not
    // Postgres. The two are within seconds of each other, so the number cannot
    // tell them apart — read the ERROR STRING. It matters practically: on the
    // gateway path the statement is NOT cancelled when the client gives up, so
    // each failed nightly run leaves ~100s of scan still burning after the
    // failure has already been recorded.
    //
    // ⚠ Column projection is NOT the lever, tested rather than assumed: the
    // unnarrowed SELECT * timed out at 110s and an eight-column projection
    // still took 101.4s. The cost is the 850,490-entry walk.
    //
    // ⛔ Do NOT "fix" this by sourcing candidates from edition_fmv_current. It
    // is 771x cheaper (1,038 buffers / 363 ms) and LOSES 71% OF THE ROWS —
    // one statement, one MVCC snapshot, set difference: old 14 / new 4 /
    // in_old_not_new 10 / in_new_not_old 0. It stores stale copies of the very
    // columns the predicate tests, so it drops editions whose TRUE latest
    // snapshot qualifies. Zero false positives is what makes it dangerous.
    // Full write-up + the re-runnable refutation query:
    // docs/overnight/inbox/2026-08-24T0455Z-the-fmv-haircut-topshot-leg-costs-800k-buffers-and-the-obvious-fix-loses-71pct-of-it.md
    //
    // Severity is MEDIUM, not an accuracy breach: /api/fmv-recalc applies the
    // haircut inline per collection on every pass and this daily job is a
    // catch-up sweep. Verified while measuring — topshot_fmv_stale_hours 0.1
    // against a breach threshold of 6.
    let legs: Array<{ id: string | null; slug: string }>
    if (collectionId) {
      legs = [{ id: collectionId, slug: collectionParam ?? "unknown" }]
    } else {
      const { data: rows, error: listErr } = await (supabaseAdmin as any)
        .from("collections")
        .select("id, slug")
        .order("slug", { ascending: true })
      if (listErr || !Array.isArray(rows) || rows.length === 0) {
        // Fall back to the original single un-scoped call rather than skipping
        // the run: a failed catalogue read must not silently narrow the sweep.
        legs = [{ id: null, slug: "all" }]
      } else {
        legs = rows.map((r: { id: string; slug: string }) => ({ id: r.id, slug: r.slug }))
      }
    }

    const legResults: Array<{
      slug: string
      ok: boolean
      rows_examined: number
      rows_haircut: number
      dollars_removed: number
      error: string | null
    }> = []

    for (const leg of legs) {
      // 2026-06-11: the haircut RPC previously sat OUTSIDE a try/catch, so a
      // THROW (pool timeout under saturation, not a returned error) rejected
      // the after() before any log_pipeline_run — a silent run while
      // cron-job.org acked green. Capture the thrown case alongside the
      // existing returned-error path. Per-leg now, so one bad leg cannot
      // discard the legs that already succeeded.
      let legData: any = null
      let legError: { message: string } | null = null
      try {
        const res = await supabaseAdmin.rpc("fmv_apply_thin_sale_haircut", {
          p_collection_id: leg.id,
          p_dry_run: false,
        })
        legData = res.data
        legError = res.error
      } catch (e) {
        legError = { message: e instanceof Error ? e.message : String(e) }
      }

      const legRow = Array.isArray(legData) && legData.length > 0 ? legData[0] : null
      legResults.push({
        slug: leg.slug,
        ok: !legError,
        rows_examined: Number(legRow?.rows_examined ?? 0),
        rows_haircut: Number(legRow?.rows_haircut ?? 0),
        dollars_removed: Number(legRow?.total_dollars_removed ?? 0),
        error: legError?.message ?? null,
      })
    }

    const failedLegs = legResults.filter((r) => !r.ok)
    // Every leg failing is the old whole-run failure and reports as one; a
    // partial failure must NOT read as success, because the un-run collections
    // did not get their haircut.
    const error: { message: string } | null =
      failedLegs.length === 0
        ? null
        : {
            message: `${failedLegs.length}/${legResults.length} legs failed: ${failedLegs
              .map((r) => `${r.slug}: ${r.error}`)
              .join(" | ")}`,
          }
    const data = [
      {
        rows_examined: legResults.reduce((s, r) => s + r.rows_examined, 0),
        rows_haircut: legResults.reduce((s, r) => s + r.rows_haircut, 0),
        total_dollars_removed: legResults.reduce((s, r) => s + r.dollars_removed, 0),
      },
    ]

    if (error) {
      console.error(
        `[apply-fmv-haircut] mode=live collection=${collectionParam ?? "all"} error: ${error.message}`
      );
      try {
        // ⚠ Report what the SURVIVING legs actually did, not 0. Hardcoding 0
        // here predates the split, when any failure meant the whole statement
        // rolled back and nothing was written. With per-collection legs a
        // failure is partial, and publishing 0 would understate real applied
        // haircuts — the mirror of the drain-fmv-cold-tail defect fixed the
        // same day, where a working pipeline reported nothing.
        const partialExamined = legResults.reduce((s, r) => s + r.rows_examined, 0)
        const partialHaircut = legResults.reduce((s, r) => s + r.rows_haircut, 0)
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: "apply-fmv-haircut",
          p_started_at: startedAtIso,
          p_rows_found: partialExamined,
          p_rows_written: partialHaircut,
          p_rows_skipped: Math.max(0, partialExamined - partialHaircut),
          p_ok: false,
          p_error: error.message,
          p_collection_slug: collectionParam ?? null,
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: {
            mode,
            total_dollars_removed: legResults.reduce((s, r) => s + r.dollars_removed, 0),
            legs: legResults,
            legs_failed: failedLegs.length,
            legs_total: legResults.length,
          },
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
        p_extra: {
          mode,
          total_dollars_removed: totalDollarsRemoved,
          legs: legResults,
          legs_failed: 0,
          legs_total: legResults.length,
        },
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
