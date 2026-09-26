import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { derivePackAvailability, packEvBasis } from "@/lib/pack-availability"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

// GET /api/packs?collection=<slug>&sort=<key>&tier=<tier>&search=<q>&limit=<n>
//
// Reads from the `pack_table_rows` view — the unified pack catalog shared by
// Top Shot, All Day, and Golazos. Returns PackTable-ready rows.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// disney-pinnacle added 2026-07-06 — render-keyed supply-weighted pack EV via
// the compute-pinnacle-pack-ev pipeline (no TS/AllDay corrected-EV merge; uses
// the base modeled EV from pack_table_rows / mv_pack_ev_latest).
// laliga-golazos re-added 2026-07-07 — the compute-golazos-pack-ev pipeline is
// the AllDay v8 clone (supply/circulation-weighted EV baked into the writer), so
// the base EV in pack_table_rows is already odds-aware; no corrected-EV merge.
const ALLOWED_COLLECTIONS = new Set(["nba-top-shot", "nfl-all-day", "disney-pinnacle", "laliga-golazos"])

type SortKey = "value_ratio_desc" | "ev_margin_pct_desc" | "retail_price_asc" | "title_asc"
const ALLOWED_SORTS = new Set<SortKey>([
  "value_ratio_desc",
  "ev_margin_pct_desc",
  "retail_price_asc",
  "title_asc",
])

function sortToColumn(sort: SortKey): { column: string; ascending: boolean; nullsFirst: boolean } {
  switch (sort) {
    case "value_ratio_desc":
      return { column: "value_ratio", ascending: false, nullsFirst: false }
    case "ev_margin_pct_desc":
      return { column: "ev_margin_pct", ascending: false, nullsFirst: false }
    case "retail_price_asc":
      return { column: "retail_price_usd", ascending: true, nullsFirst: false }
    case "title_asc":
      return { column: "title", ascending: true, nullsFirst: false }
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collection = url.searchParams.get("collection") ?? ""
  const sortParam = (url.searchParams.get("sort") ?? "value_ratio_desc") as SortKey
  const tier = url.searchParams.get("tier")?.trim() || null
  const search = url.searchParams.get("search")?.trim() || null
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 100

  if (!ALLOWED_COLLECTIONS.has(collection)) {
    return NextResponse.json(
      { error: "collection must be one of: " + Array.from(ALLOWED_COLLECTIONS).join(", ") },
      { status: 400 },
    )
  }
  const sort: SortKey = ALLOWED_SORTS.has(sortParam) ? sortParam : "value_ratio_desc"
  const { column, ascending, nullsFirst } = sortToColumn(sort)

  let query = supabase
    .from("pack_table_rows")
    .select("*", { count: "exact" })
    .eq("collection_slug", collection)

  if (tier) query = query.eq("tier", tier)
  if (search) query = query.ilike("title", "%" + search + "%")

  // Golazos: hide the Dapper internal test/split dists ("Jornadas 1-9 (Stress
  // test)", any "(Split)") — they're not real consumer packs and the stress-test
  // dist headlines the board with an inflated 5.9x ratio. Mirrors the Pinnacle
  // "[OLD]" filtering. Scoped to Golazos so other collections are untouched.
  // Stress-test dists are Dapper-internal QA in every collection (e.g. TS
  // "2026 Stress Test Pack 5") — hide them from the board universally.
  query = query.not("title", "ilike", "%Stress test%")
  if (collection === "laliga-golazos") {
    query = query.not("title", "ilike", "%(Split)%")
  }

  const { data, count, error } = await query
    .order(column, { ascending, nullsFirst })
    .limit(limit)

  if (error) {
    return apiErrorResponse(error, "api/packs")
  }

  let rows = data ?? []

  // dist_ids for the packs actually on this page. The EV-merge views below are
  // fetched scoped to these ids (`.in("dist_id", distIds)`) rather than whole:
  // v_allday_pack_info alone holds ~3,000 rows, so a whole-view `.limit(4000)`
  // was silently clamped to PostgREST's 1,000-row cap (and unordered), leaving
  // ~2,000 AllDay packs without their corrected EV — they fell back to the
  // over-stated modeled EV the correction exists to fix. Scoping to the page's
  // dist_ids (<= limit, max 1,000) is both correct and lighter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const distIds = Array.from(new Set((rows as any[]).map((r) => r.dist_id).filter((x) => x != null)))

  // Reality-adjusted EV (Top Shot only): merge v_topshot_pack_ev_calibrated by
  // dist_id so the packs page can headline calibrated EV where we have enough
  // observed opens. The view is TS-only (~800 rows) and bakes in the
  // modeled-fallback, so we fetch it whole and map by dist_id. Non-fatal: if it
  // errors the page just shows pure modeled EV.
  if (collection === "nba-top-shot" && rows.length) {
    const { data: calData, error: calError } = await boundedRead(supabase
      .from("v_topshot_pack_ev_calibrated")
      .select(
        "dist_id, calibrated_gross_ev, calibrated_net_ev, calibrated_margin_pct, calibration_applied",
      )
      .eq("calibration_applied", true)
      .in("dist_id", distIds), "api/packs/v_topshot_pack_ev_calibrated")
    if (calError) {
      console.error("[api/packs] calibrated merge", calError.message)
    } else if (calData?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (calData as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = calMap.get(String(r.dist_id))
        return c
          ? {
              ...r,
              calibrated_gross_ev: c.calibrated_gross_ev,
              calibrated_net_ev: c.calibrated_net_ev,
              calibrated_margin_pct: c.calibrated_margin_pct,
              calibration_applied: c.calibration_applied,
            }
          : r
      })
    }
  }

  // Corrected EV (NFL All Day only): the canonical AllDay EV is a flat
  // top-10%-trimmed avg(fmv) × slots that ignores pull odds — it over-states
  // rare-heavy packs (a $4 pack modeled at $430). v_allday_pack_info exposes an
  // odds/median-robust corrected EV; overwrite the canonical display columns
  // with it (mirrors the TS calibrated headline) so the list and the dist page
  // agree, and attach low_confidence_ev/ev_method for the caveat chip. Non-fatal.
  if (collection === "nfl-all-day" && rows.length) {
    // v_allday_pack_detail_ev, NOT v_allday_pack_info: same columns/values (verified
    // 0-row EXCEPT diff over all 3,052 AllDay dists) minus that view's pack_ev_latest
    // join, whose predicate cannot push below its DISTINCT ON. Per dist this is an
    // index scan (cost 7.54) instead of a 119,591-row scan shared across the page.
    // See migration 20260809170000_audit_20260809_allday_pack_detail_ev_lean_view.
    const { data: corr, error: corrError } = await boundedRead(supabase
      .from("v_allday_pack_detail_ev")
      .select("dist_id, corrected_gross_ev, corrected_net_ev, corrected_value_ratio, ev_method, low_confidence_ev")
      .in("dist_id", distIds), "api/packs/v_allday_pack_detail_ev")
    if (corrError) {
      console.error("[api/packs] allday corrected merge", corrError.message)
    } else if (corr?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const corrMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (corr as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = corrMap.get(String(r.dist_id))
        if (!c || c.corrected_gross_ev == null) return r
        const ratio = c.corrected_value_ratio == null ? null : Number(c.corrected_value_ratio)
        return {
          ...r,
          gross_ev: c.corrected_gross_ev,
          pack_ev: c.corrected_net_ev,
          value_ratio: c.corrected_value_ratio,
          // Same scale the view stores: (net/price)*100 = (value_ratio-1)*100.
          ev_margin_pct: ratio === null ? r.ev_margin_pct : (ratio - 1) * 100,
          low_confidence_ev: c.low_confidence_ev,
          ev_method: c.ev_method,
        }
      })
    }
  }

  // Corrected EV (Disney Pinnacle only): the raw modeled EV from pack_table_rows
  // is a supply-weighted MEAN of render FMVs, which a single ASK_ONLY chase render
  // over-states on tiny sold-out packs (the 531x "Summer Splash" case).
  // v_pinnacle_pack_ev_corrected recomputes a median-within-supply-group EV and
  // flags low-confidence packs; overwrite the display columns with it (mirrors the
  // TS calibrated + AllDay corrected merges) and attach low_confidence_ev/ev_method
  // for the caveat chip. Non-fatal.
  if (collection === "disney-pinnacle" && rows.length) {
    const { data: corr, error: corrError } = await boundedRead(supabase
      .from("v_pinnacle_pack_ev_corrected")
      .select("dist_id, corrected_gross_ev, corrected_net_ev, corrected_value_ratio, ev_method, low_confidence_ev")
      .in("dist_id", distIds), "api/packs/v_pinnacle_pack_ev_corrected")
    if (corrError) {
      console.error("[api/packs] pinnacle corrected merge", corrError.message)
    } else if (corr?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const corrMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (corr as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = corrMap.get(String(r.dist_id))
        if (!c || c.corrected_gross_ev == null) return r
        const ratio = c.corrected_value_ratio == null ? null : Number(c.corrected_value_ratio)
        return {
          ...r,
          gross_ev: c.corrected_gross_ev,
          pack_ev: c.corrected_net_ev,
          value_ratio: c.corrected_value_ratio,
          // Same scale the AllDay block uses: (net/price)*100 = (value_ratio-1)*100.
          ev_margin_pct: ratio === null ? r.ev_margin_pct : (ratio - 1) * 100,
          low_confidence_ev: c.low_confidence_ev,
          ev_method: c.ev_method,
        }
      })
    }
  }

  // Actionability + EV basis. Both are DISCLOSURE, not filtering: the rows are
  // unchanged and the default view still returns every pack, because a retired
  // pack's EV is legitimate history. What changes is that each row now SAYS
  // whether anyone can act on it, so a green ratio on an unbuyable pack cannot be
  // mistaken for a buy signal. Measured 2026-08-02: every All Day (3,111),
  // Golazos (202) and Pinnacle (81) pack EV on the site describes a pack that is
  // neither on sale nor listed. See lib/pack-availability.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows = (rows as any[]).map((r) => {
    const avail = derivePackAvailability(r)
    return {
      ...r,
      pack_availability: avail.status,
      pack_availability_label: avail.label,
      pack_availability_note: avail.note,
      ev_is_historical: avail.historical,
    }
  })

  const basis = packEvBasis(collection)

  return NextResponse.json(
    {
      rows,
      total: count ?? (rows.length ?? 0),
      collection_slug: collection,
      // Which pool the EV above was weighted by. Null for collections we do not
      // model a drop pool for (Pinnacle), where neither label would be true.
      ev_basis: basis
        ? { basis: basis.basis, label: basis.label, note: basis.note }
        : null,
      availability_counts: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primary: (rows as any[]).filter((r) => r.pack_availability === "primary").length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        secondary: (rows as any[]).filter((r) => r.pack_availability === "secondary").length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        retired: (rows as any[]).filter((r) => r.pack_availability === "retired").length,
      },
    },
    {
      // Global pack catalog (pack_table_rows by collection_slug) — not
      // user-specific, safe to share at the edge. Warms cold pack-page loads.
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=240" },
    },
  )
}
