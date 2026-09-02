import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { safeApiError, statusForSafeError } from "@/lib/api-error"

// ── THE HIGH/MEDIUM SHARE COMES FROM get_collection_stats, NOT A SECOND SCAN ──
//
// `fmv_high_medium_count` / `fmv_high_medium_pct` are the share of this
// collection's editions whose LATEST FMV snapshot is HIGH or MEDIUM confidence.
// They exist because "FMV Coverage 100%" was misleading — a collection can have a
// snapshot for every edition and still have ~43% of them labelled NO_DATA.
//
// ⛔ THIS ROUTE USED TO COMPUTE THEM ITSELF, and that was a duplicate of work the
// RPC had already done. `get_collection_stats` walks every edition with one
// `fmv_snapshots` probe each to produce `fmv_covered`; `computeHighMediumPct()`
// then ran the BYTE-EQUIVALENT scan a second time through `query_sql` for a
// different FILTER, inside the same `Promise.all`. Wall-clock hid it. The DB load
// is the SUM, and this instance is IO-bound.
//
// MEASURED 2026-09-02, quiet band (so this is the FLOOR, not the typical cost):
// the second pass alone was 116,945 buffers / 2,875 ms / 19,942 lateral loops on
// Top Shot. Migration
// `20260902054902_audit_20260902_collection_stats_folds_the_high_medium_pass_into_the_scan_it_already_makes`
// folded the aggregate into the pass the function already makes — proved
// row-for-row equivalent against the query below, in a single snapshot — so this
// route now reads the numbers straight off the RPC payload.
//
// 👉 If you are about to add another per-edition metric here: add it to the
// function's existing aggregate, not to a second query.

// A failed stats read must NOT be served as HTTP 200.
//
// WHY (deep-audit D11). This route used to return `{error:"stats_unavailable"}`
// with status 200. Its only consumer guards with `if (!res.ok) throw`, so 200
// passed, the error object was stored as `stats`, and `stats` became TRUTHY —
// at which point every KPI fell through its `?? 0` and the page rendered
// "TOTAL EDITIONS 0 / PRICED 0%" for a collection with 6,190 editions. A
// database timeout was displayed to visitors as a measurement, and the page's
// own error banner never fired because `catch` was never reached.
//
// The page is already correct when `stats` is null (it renders an em-dash), so
// the honest status is all that was ever missing. 503 + Retry-After matches the
// D3 precedent in lib/api-error.ts: transient capacity, not genuine breakage,
// and never the driver's own message.
function statsUnavailable(err: unknown, where: string) {
  const safe = safeApiError(err, "Collection stats aren't available right now.")
  console.log(
    "[collection-stats] " + where + " code=" + safe.code + " detail=" + readErrDetail(err)
  )
  return NextResponse.json(safe, {
    status: statusForSafeError(safe),
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...(safe.retryable ? { "Retry-After": "30" } : {}),
    },
  })
}

// Detail goes to the log, never the response body.
function readErrDetail(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown }
    return String(e.code ?? "") + ":" + String(e.message ?? "")
  }
  return String(err)
}

export async function GET(req: NextRequest) {
  const collection = req.nextUrl.searchParams.get("collection")
  if (!collection) {
    return NextResponse.json({ error: "collection param required" }, { status: 400 })
  }

  const normalized = collection.replace(/-/g, "_")

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_collection_stats", {
      p_slug: normalized,
    })

    if (error) {
      return statsUnavailable(error, "rpc_error")
    }

    if (data && typeof data === "object" && !Array.isArray(data) && (data as any).error) {
      return NextResponse.json(data, { status: 404 })
    }

    // ⚠ The two keys are NORMALIZED TO null when the RPC does not carry them,
    // never defaulted to 0 or to a different metric. An absent field would
    // otherwise vanish from the JSON entirely and the consumer could not tell
    // "not measured" from "measured as zero" — and zero here is a real value
    // (UFC Strike is genuinely 0.0%).
    const enriched =
      data && typeof data === "object" && !Array.isArray(data)
        ? {
            ...data,
            fmv_high_medium_count: (data as any).fmv_high_medium_count ?? null,
            fmv_high_medium_pct: (data as any).fmv_high_medium_pct ?? null,
          }
        : data

    return NextResponse.json(enriched, {
      headers: {
        "Cache-Control": "s-maxage=300, stale-while-revalidate=60",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (err) {
    return statsUnavailable(err, "exception")
  }
}
