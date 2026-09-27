// app/api/panini-pack-market/route.ts
//
// Panini Packs tab backend (2026-09-27). Panini sells two sealed WC Prizm pack
// products (Hobby, 4 cards; FOTL, 5 cards incl. one FOTL-exclusive parallel) on
// its own platform. None of it lives in `pack_distributions`, so the shared Flow
// pack board (/api/packs → pack_table_rows) has nothing to read; this route
// reads Panini's native pack plane instead: `panini_pack_ev_board` (Panini's own
// market stats per product + the pack-EV model), `panini_pack_state.raw` (the
// product's published name + guaranteed contents + odds), and
// `panini_pack_state_history` (the price trail the runner records per walk).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · The EV board is the page's primary read: if it fails the route answers 503
//     through `apiErrorResponse`, never a zeroed board.
//   · Every SECONDARY panel (product details, price history, coverage) carries its
//     own `*_error` flag, so "no history" and "the history read failed" are
//     different payloads (three states: failed · empty · rows).
//   · THE PRICE IS PANINI'S OWN MARKET STAT, stamped by the residential runner
//     (~4-hourly). It is not re-read per request, so each product carries its
//     `updatedAt` and a `stale` flag past PANINI_PACK_STALE_HOURS — a price from
//     three days ago must not read as "the price".
//   · `pack_cost_usd` in the view is COALESCE(floor, average sale). When the floor
//     is missing the tile says the cost is an AVERAGE SALE (`costBasis`), not a
//     floor someone could buy at.
//   · The EV legs are priced off FMV on a LISTING-GATED index (Panini publishes no
//     checklist), so the tab carries the coverage disclosure — the client renders
//     it unconditionally and adds figures only when `coverage` read ok.
//   · "Typical pull" leads; the chase-inclusive mean is secondary (house rule for
//     every pack-EV surface).
//   · No per-user panel: Panini owners are platform usernames with no public
//     holdings read, so there is no "your sealed packs" to show.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { readPaniniCoverage } from "@/lib/panini/coverage"
import { packLabel, parsePackDetails } from "@/lib/panini/pack-market"

export const dynamic = "force-dynamic"
export const maxDuration = 30

/**
 * Past this age a product's market stats are flagged stale.
 * ⚠ DERIVED FROM THE WRITER: the residential runner (scripts/ingest-panini-runner.mjs,
 * Windows Task Scheduler every 4 h) posts pack market data up-front on each run;
 * 24 h is six missed runs — the box is dark, not merely late.
 */
export const PANINI_PACK_STALE_HOURS = 24

/** How far back the price trail reaches. */
export const PANINI_PACK_HISTORY_DAYS = 30
const MAX_HISTORY_ROWS = 500

const EV_COLS =
  "id,pack_type,pack_cost_usd,floor_usd,avg_sale_usd,recent_sale_usd,cards_per_pack,packs_total,packs_remaining," +
  "packs_ripped_pct,actual_ev_usd,typical_ev_usd,silver_ev,base_parallel_ev,insert_ev,fotl_exclusive_ev," +
  "net_rip_edge_usd,model_note,updated_at"

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

export async function GET() {
  const now = Date.now()
  try {
    const db = supabaseAdmin as any
    const [evRes, stateRes, histRes, coverage] = await Promise.all([
      boundedRead(db.from("panini_pack_ev_board").select(EV_COLS).order("pack_type", { ascending: true }), "panini-pack-market/ev"),
      boundedRead(db.from("panini_pack_state").select("id,pack_type,raw"), "panini-pack-market/state"),
      boundedRead(
        db
          .from("panini_pack_state_history")
          .select("pack_type,observed_at,floor_usd,recent_sale_usd,avg_sale_usd,packs_remaining")
          .gte("observed_at", new Date(now - PANINI_PACK_HISTORY_DAYS * 86_400_000).toISOString())
          .order("observed_at", { ascending: false })
          .order("pack_type", { ascending: true })
          .limit(MAX_HISTORY_ROWS),
        "panini-pack-market/history",
      ),
      readPaniniCoverage(db, "api/panini-pack-market"),
    ])

    // The primary read: a failure is a 503, never an empty board.
    if (evRes.error) return apiErrorResponse(evRes.error, "api/panini-pack-market", "Pack market is unavailable right now.")

    const details = new Map<string, ReturnType<typeof parsePackDetails>>()
    if (stateRes.error) {
      console.error("[panini-pack-market] product details read failed:", stateRes.error)
    } else {
      for (const r of (stateRes.data ?? []) as { id: string; raw: unknown }[]) details.set(String(r.id), parsePackDetails(r.raw))
    }

    const products = ((evRes.data ?? []) as Record<string, unknown>[]).map((p) => {
      const updatedAt = str(p.updated_at)
      const t = updatedAt ? Date.parse(updatedAt) : NaN
      const ageHours = Number.isNaN(t) ? null : Math.max(0, (now - t) / 3_600_000)
      const floor = num(p.floor_usd)
      const d = details.get(String(p.id)) ?? null
      const packType = String(p.pack_type ?? "")
      return {
        id: String(p.id),
        packType,
        label: packLabel(packType),
        name: d?.name ?? null,
        imageUrl: d?.imageUrl ?? null,
        labels: d?.labels ?? [],
        cardsPerPack: num(p.cards_per_pack),
        costUsd: num(p.pack_cost_usd),
        // COALESCE(floor, avg_sale) in the view — say which one it is.
        costBasis: floor !== null ? ("floor" as const) : num(p.avg_sale_usd) !== null ? ("avg_sale" as const) : null,
        floorUsd: floor,
        avgSaleUsd: num(p.avg_sale_usd),
        recentSaleUsd: num(p.recent_sale_usd),
        topSaleUsd: d?.topSaleUsd ?? null,
        listedCount: d?.listedCount ?? null,
        packsTotal: num(p.packs_total),
        packsRemaining: num(p.packs_remaining),
        rippedPct: num(p.packs_ripped_pct),
        typicalEvUsd: num(p.typical_ev_usd),
        actualEvUsd: num(p.actual_ev_usd),
        netRipEdgeUsd: num(p.net_rip_edge_usd),
        legs: {
          silver: num(p.silver_ev),
          baseParallel: num(p.base_parallel_ev),
          insert: num(p.insert_ev),
          fotlExclusive: packType === "fotl" ? num(p.fotl_exclusive_ev) : null,
        },
        modelNote: str(p.model_note),
        updatedAt,
        stale: ageHours === null || ageHours > PANINI_PACK_STALE_HOURS,
      }
    })

    const history = histRes.error
      ? null
      : ((histRes.data ?? []) as Record<string, unknown>[]).map((h) => ({
          packType: String(h.pack_type ?? ""),
          observedAt: str(h.observed_at),
          floorUsd: num(h.floor_usd),
          recentSaleUsd: num(h.recent_sale_usd),
          avgSaleUsd: num(h.avg_sale_usd),
          packsRemaining: num(h.packs_remaining),
        }))
    if (histRes.error) console.error("[panini-pack-market] history read failed:", histRes.error)

    return NextResponse.json(
      {
        products,
        details_error: stateRes.error ? true : false,
        history,
        history_error: histRes.error ? true : false,
        history_days: PANINI_PACK_HISTORY_DAYS,
        stale_after_hours: PANINI_PACK_STALE_HOURS,
        coverage: coverage.ok ? coverage.coverage : null,
        coverage_error: !coverage.ok,
        generatedAt: new Date(now).toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/panini-pack-market", "Pack market is unavailable right now.")
  }
}
