import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { safeApiError, statusForSafeError } from "@/lib/api-error"

// % of editions whose LATEST FMV snapshot is HIGH or MEDIUM confidence.
// Reframes the misleading "FMV Coverage 100%" — a collection can have a snapshot
// for every edition yet still have ~43% labelled NO_DATA. We surface the share
// of editions priced with usable confidence instead. Pinnacle reads from
// pinnacle_fmv_snapshots (its own per-collection table); everything else uses
// the partitioned fmv_snapshots table keyed by collection_id.
async function computeHighMediumPct(
  slug: string,
): Promise<{ count: number | null; pct: number | null }> {
  try {
    const sql = slug === "disney-pinnacle"
      ? `
          -- PIN-FMV-REKEY Wave 3: per-render coverage from pinnacle_catalog
          -- (one row per render_id) instead of the retiring per-edition blend.
          SELECT
            (SELECT COUNT(*) FROM pinnacle_catalog WHERE fmv_confidence IN ('HIGH','MEDIUM')) AS high_medium,
            (SELECT COUNT(*) FROM pinnacle_catalog) AS edition_total
        `
      : `
          WITH latest AS (
            SELECT l.confidence
            FROM editions e
            CROSS JOIN LATERAL (
              SELECT fs.confidence
              FROM fmv_snapshots fs
              WHERE fs.collection_id = '${COLLECTION_UUID_BY_SLUG[slug] ?? ""}'
                AND fs.edition_id = e.id
              ORDER BY fs.computed_at DESC
              LIMIT 1
            ) l
            WHERE e.collection_id = '${COLLECTION_UUID_BY_SLUG[slug] ?? ""}'
          ),
          ed AS (
            SELECT COUNT(*) AS total
            FROM editions
            WHERE collection_id = '${COLLECTION_UUID_BY_SLUG[slug] ?? ""}'
          )
          SELECT
            (SELECT COUNT(*) FROM latest WHERE confidence IN ('HIGH','MEDIUM')) AS high_medium,
            (SELECT total FROM ed) AS edition_total
        `

    const { data, error } = await (supabaseAdmin as any).rpc("query_sql", { query: sql })
    if (error || !data) return { count: null, pct: null }
    const row = Array.isArray(data) ? data[0] : data
    const hm = Number(row?.high_medium ?? 0)
    const total = Number(row?.edition_total ?? 0)
    if (!Number.isFinite(hm) || !Number.isFinite(total) || total <= 0) {
      return { count: hm, pct: null }
    }
    return { count: hm, pct: (hm / total) * 100 }
  } catch {
    return { count: null, pct: null }
  }
}

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
    const [statsRes, hmRes] = await Promise.all([
      (supabaseAdmin as any).rpc("get_collection_stats", { p_slug: normalized }),
      computeHighMediumPct(collection),
    ])
    const { data, error } = statsRes

    if (error) {
      return statsUnavailable(error, "rpc_error")
    }

    if (data && typeof data === "object" && !Array.isArray(data) && (data as any).error) {
      return NextResponse.json(data, { status: 404 })
    }

    const enriched =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...data, fmv_high_medium_count: hmRes.count, fmv_high_medium_pct: hmRes.pct }
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
