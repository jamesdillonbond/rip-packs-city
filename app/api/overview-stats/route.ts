import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  getCollectionUuid,
  toDbSlug,
} from "@/lib/collections"

// Per-collection overview stats for the overview page KPI cards.
// Returns: totalEditions, highConfCount (HIGH-confidence FMV coverage),
// volume24h, and up to 5 FMV movers. All queries are filtered by the
// resolved collection UUID. Disney Pinnacle is routed to its dedicated
// tables (pinnacle_editions, pinnacle_fmv_snapshots, pinnacle_sales);
// all other collections hit the shared editions / fmv_snapshots / sales
// tables via collection_id.

export const maxDuration = 20

type MarketPulseRow = {
  slug: string
  sales_24h: number | null
  volume_24h: number | null
}

async function getVolume24hFromPulse(dbSlug: string | null): Promise<number> {
  if (!dbSlug) return 0
  try {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_market_pulse_all"
    )
    if (error) return 0
    const rows = (data ?? []) as MarketPulseRow[]
    const hit = rows.find((r) => r.slug === dbSlug)
    return Number(hit?.volume_24h ?? 0)
  } catch {
    return 0
  }
}

async function pinnacleStats() {
  // PIN-FMV-REKEY Wave 3: per-render counts from pinnacle_catalog (one row per
  // render_id) instead of set-level pinnacle_editions + the retiring blend.
  const [editionsRes, highConfRes] = await Promise.all([
    (supabaseAdmin as any)
      .from("pinnacle_catalog")
      .select("render_id", { count: "exact", head: true }),
    (supabaseAdmin as any)
      .from("pinnacle_catalog")
      .select("render_id", { count: "exact", head: true })
      .eq("fmv_confidence", "HIGH"),
  ])
  return {
    totalEditions: countOrNull(editionsRes),
    highConfCount: countOrNull(highConfRes),
  }
}

/**
 * A count we could not read is `null`, never `0`.
 *
 * ⚠ THE TRAP THIS EXISTS FOR: a supabase count query that FAILS still
 * *resolves* — supabase-js returns `{ count: null, error }` rather than
 * throwing — so a `status === "fulfilled"` check is satisfied and `count ?? 0`
 * publishes a hard zero. Isolating the legs with `allSettled` (which this route
 * did, for good reason, after one rejection zeroed the whole KPI strip) bounds
 * the blast radius of a failure; it does not stop the failing leg itself
 * asserting "there are none".
 *
 * ⚠ LATENT, NOT LIVE, and worth saying so: no in-repo consumer renders these
 * fields today. Fixed because this is a documented endpoint whose field names
 * promise a measurement — the same reason `meta.total_rows` was fixed on the
 * insights routes — not because a surface was observed lying.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countOrNull(res: any): number | null {
  if (res?.error) return null
  return res?.count ?? null
}

/**
 * The `allSettled` sibling. ⚠ Kept SEPARATE rather than making `countOrNull`
 * accept both shapes: the two callers really do hold different things — a raw
 * `{ count, error }` from `Promise.all` and a `PromiseSettledResult` wrapping
 * one — and a helper that sniffs for `.status` would silently return null for a
 * raw result that legitimately carried a `status` field of its own.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function settledCountOrNull(settled: PromiseSettledResult<any>): number | null {
  if (settled.status !== "fulfilled") return null
  return countOrNull(settled.value)
}

async function standardStats(collectionId: string) {
  // Each count is caught independently so a slow/failed FMV-HIGH count over a
  // huge collection's fmv_snapshots never zeroes the edition count too.
  const [editionsRes, highConfRes] = await Promise.allSettled([
    (supabaseAdmin as any)
      .from("editions")
      .select("id", { count: "exact", head: true })
      .eq("collection_id", collectionId),
    // Count DISTINCT editions currently at HIGH confidence, not raw snapshot rows.
    // fmv_snapshots keeps daily history (many rows per edition), so counting it
    // returned ~14x the true number — more "high-confidence editions" than total
    // editions. fmv_current is DISTINCT ON (edition_id) latest-per-edition.
    (supabaseAdmin as any)
      .from("fmv_current")
      .select("edition_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("confidence", "HIGH"),
  ])
  return {
    totalEditions: settledCountOrNull(editionsRes),
    highConfCount: settledCountOrNull(highConfRes),
  }
}

export async function GET(req: NextRequest) {
  try {
    const slug = req.nextUrl.searchParams.get("collection")?.trim() || "nba-top-shot"
    const collectionId = getCollectionUuid(slug)
    const dbSlug = toDbSlug(slug)

    if (!collectionId) {
      return NextResponse.json(
        { totalEditions: 0, highConfCount: 0, volume24h: 0, movers: [] },
        { status: 200 }
      )
    }

    const isPinnacle = slug === "disney-pinnacle"

    // Resilient fan-out: each stat is independent, so a slow/failed 24h market
    // pulse or FMV-movers query can NEVER zero the edition + confidence counts.
    // Previously a single rejection in Promise.all sent the whole overview to
    // 0/0/$0 — which is exactly how the biggest collection (Top Shot) landed on
    // an all-zero KPI strip while smaller collections rendered fine.
    const [statsSettled, volumeSettled, moversSettled] = await Promise.allSettled([
      isPinnacle ? pinnacleStats() : standardStats(collectionId),
      getVolume24hFromPulse(dbSlug),
      // get_fmv_movers accepts p_collection_id but currently only walks
      // fmv_snapshots, so it naturally returns [] for Pinnacle — fine.
      (supabaseAdmin as any).rpc("get_fmv_movers", {
        lookback_interval: "24 hours",
        min_fmv: 1,
        limit_count: 5,
        p_collection_id: collectionId,
      }),
    ])

    const stats = statsSettled.status === "fulfilled" ? statsSettled.value : { totalEditions: 0, highConfCount: 0 }
    const volume24h = volumeSettled.status === "fulfilled" ? volumeSettled.value : 0
    const movers = moversSettled.status === "fulfilled" ? (moversSettled.value.data ?? []) : []

    return NextResponse.json(
      {
        totalEditions: stats.totalEditions,
        highConfCount: stats.highConfCount,
        volume24h,
        movers,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      }
    )
  } catch (err) {
    console.log("[overview-stats] error:", err)
    return NextResponse.json(
      { totalEditions: 0, highConfCount: 0, volume24h: 0, movers: [] },
      { status: 500 }
    )
  }
}
