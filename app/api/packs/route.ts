import { NextRequest, NextResponse } from "next/server"
import { PACK_LISTING_COLLECTIONS } from "@/lib/packs/pack-listing-collections"
import { createClient } from "@supabase/supabase-js"
import { derivePackAvailability, packEvBasis } from "@/lib/pack-availability"
import { apiErrorResponse } from "@/lib/api-error"
import { accentInsensitiveRegex } from "@/lib/search/accent-regex"
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

// Which collections this route serves, and why: lib/packs/pack-listing-collections.ts
// (shared with the site-wide warm-up so the two cannot drift).
const ALLOWED_COLLECTIONS = PACK_LISTING_COLLECTIONS

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

  // The board's scope, shared by the ordinary read and its accent-blind retry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => {
    q = q.eq("collection_slug", collection)
    if (tier) q = q.eq("tier", tier)
    // Golazos: hide the Dapper internal test/split dists ("Jornadas 1-9 (Stress
    // test)", any "(Split)") — they're not real consumer packs and the stress-test
    // dist headlines the board with an inflated 5.9x ratio. Mirrors the Pinnacle
    // "[OLD]" filtering. Scoped to Golazos so other collections are untouched.
    // Stress-test dists are Dapper-internal QA in every collection (e.g. TS
    // "2026 Stress Test Pack 5") — hide them from the board universally.
    q = q.not("title", "ilike", "%Stress test%")
    if (collection === "laliga-golazos") q = q.not("title", "ilike", "%(Split)%")
    return q
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readPage = (titleFilter: (q: any) => any) =>
    titleFilter(scoped(supabase.from("pack_table_rows").select("*", { count: "exact" })))
      .order(column, { ascending, nullsFirst })
      .limit(limit)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data, count, error } = await readPage((q: any) => (search ? q.ilike("title", "%" + search + "%") : q))
  // #207: "clasico" found none of Golazos' 23 "ElClásico" packs. An EMPTY search
  // is re-run once with the exact accent-blind regex (lib/search/accent-regex), so
  // count, sort and paging stay exact. A search that matched is never re-run.
  const titleRx = !error && search && (data ?? []).length === 0 ? accentInsensitiveRegex(search) : null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (titleRx) ({ data, count, error } = await readPage((q: any) => q.filter("title", "imatch", titleRx)))

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

  // Reality-adjusted EV (Top Shot only): the calibrated EV from the MV-backed
  // v_topshot_pack_realized_ev, merged by dist_id onto the page's rows.
  //
  // 2026-10-19: this read v_topshot_pack_ev_calibrated, which rebuilds
  // pack_ev_latest — a DISTINCT ON over all ~666k pack_ev_history rows that the
  // Top Shot filter cannot push below — on every call (mean 3.3 s, ~106k buffers,
  // two 8 s timeouts in 48 h; pack-ev.md). Its calibrated_ev is the MV's own
  // column (gross identical on all 213 overlapping dists, measured 10-19), so the
  // MV is read directly and the view's two other choices are made HERE:
  //   - Calibration applies only where the board row carries a modeled EV
  //     (gross_ev not null). The view also calibrated 5 dists whose EV the board's
  //     own guard withholds (pack_table_rows' "EV > 3× live ask" / sentinel
  //     rules), and 90 more have a realized calibration but no board EV at all:
  //     none of them is given an EV here that the board withheld.
  //   - Net and margin are against the row's live secondary ask only — the board's
  //     verdict anchor (PackPageClient: primary/retail is never the anchor). The
  //     view used its own stale price (dist 1202: $2 retail vs the $4 live ask).
  // Non-fatal: on error the page shows pure modeled EV.
  if (collection === "nba-top-shot" && rows.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evIds = (rows as any[]).filter((r) => r.gross_ev != null).map((r) => r.dist_id)
    const { data: calData, error: calError } = evIds.length
      ? await boundedRead(supabase
          .from("v_topshot_pack_realized_ev")
          .select("dist_id, calibrated_ev")
          .not("calibrated_ev", "is", null)
          .in("dist_id", evIds), "api/packs/v_topshot_pack_realized_ev")
      : { data: [], error: null }
    if (calError) {
      console.error("[api/packs] calibrated merge", calError.message)
    } else if (calData?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const calMap = new Map<string, number>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (calData as any[]).map((c) => [String(c.dist_id), Number(c.calibrated_ev)]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const cal = r.gross_ev != null ? calMap.get(String(r.dist_id)) : undefined
        if (cal === undefined || !Number.isFinite(cal)) return r
        const ask = r.secondary_available === true && Number(r.secondary_ask) > 0 ? Number(r.secondary_ask) : null
        return {
          ...r,
          calibrated_gross_ev: cal,
          calibrated_net_ev: ask === null ? null : Math.round((cal - ask) * 100) / 100,
          calibrated_margin_pct: ask === null ? null : Math.round(((cal - ask) / ask) * 1000) / 10,
          calibration_applied: true,
        }
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

  // Disney Pinnacle: EV at DROP grain (v_pinnacle_pack_drop_ev, #157). A
  // Pinnacle "Standard" pack is one product whose supply Studio splits into
  // sub-distributions ("Summer Splash - Standard - LE Standard / Quinova / …");
  // a buyer cannot choose a pool, so a pool's own EV (the 5-pack Quinova pool
  // read 811x) is not a pack's EV. Every member row carries the DROP's EV,
  // weighted by each pool's pack count, plus the pool's own EV and its share.
  // "+EV" = the sales-backed part of the EV (value not resting on asking
  // prices) beats the price. ⚠ A FAILED read withholds the EV — the fallback
  // used to be the raw per-pool model, the exact inflated number this replaces.
  if (collection === "disney-pinnacle" && rows.length) {
    const { data: corr, error: corrError } = await boundedRead(supabase
      .from("v_pinnacle_pack_drop_ev")
      .select("dist_id, drop_title, pool_name, drop_pools, pool_share_pct, pool_gross_ev, gross_ev, net_ev, value_ratio, sales_backed_ev, ask_value_share_pct, is_positive_ev, low_confidence_ev, ev_method")
      .in("dist_id", distIds), "api/packs/v_pinnacle_pack_drop_ev")
    if (corrError) {
      console.error("[api/packs] pinnacle drop EV read", corrError.message)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => ({
        ...r,
        gross_ev: null,
        pack_ev: null,
        value_ratio: null,
        ev_margin_pct: null,
        is_positive_ev: null,
        ev_unavailable: true,
      }))
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const corrMap = new Map<string, any>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((corr ?? []) as any[]).map((c) => [String(c.dist_id), c]),
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rows = (rows as any[]).map((r) => {
        const c = corrMap.get(String(r.dist_id))
        if (!c || c.gross_ev == null) return r
        const ratio = c.value_ratio == null ? null : Number(c.value_ratio)
        return {
          ...r,
          gross_ev: c.gross_ev,
          pack_ev: c.net_ev,
          value_ratio: c.value_ratio,
          // Same scale the AllDay block uses: (net/price)*100 = (value_ratio-1)*100.
          ev_margin_pct: ratio === null ? r.ev_margin_pct : (ratio - 1) * 100,
          is_positive_ev: c.is_positive_ev,
          low_confidence_ev: c.low_confidence_ev,
          ev_method: c.ev_method,
          sales_backed_ev: c.sales_backed_ev,
          ask_value_share_pct: c.ask_value_share_pct,
          drop_title: c.drop_title,
          drop_pools: c.drop_pools,
          pool_name: c.pool_name,
          pool_share_pct: c.pool_share_pct,
          pool_gross_ev: c.pool_gross_ev,
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
      // ...except when the Pinnacle EV read failed this request: rows carrying
      // ev_unavailable must not be served from the CDN for ~6 minutes (2026-10-09).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      headers: { "Cache-Control": (rows as any[]).some((r) => r?.ev_unavailable === true)
        ? "no-store"
        : "public, s-maxage=120, stale-while-revalidate=240" },
    },
  )
}
