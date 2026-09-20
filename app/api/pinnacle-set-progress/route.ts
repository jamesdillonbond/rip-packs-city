// app/api/pinnacle-set-progress/route.ts
//
// Disney Pinnacle Set Tracker backend — the last per-collection parity gap on
// the Sets tab (routes-and-surfaces.md, 2026-07-18 IA reorg: "`sets`: all
// except Pinnacle").
//
// ── WHY PINNACLE COULD NOT USE THE GENERIC /api/sets-db ─────────────────────
// `sets-db` joins `editions` + `sets` on `collection_id`. Measured 2026-09-20:
// Pinnacle has **0 rows in `editions` and 0 in `sets`** — it is catalogued
// render-keyed in `pinnacle_catalog` by design (known-issues #4; CLAUDE.md's
// "Pinnacle prices through the triple-keyed path"). So `sets-db` did not merely
// lack Pinnacle support: with `disney-pinnacle` sitting in its
// COLLECTION_UUID_MAP it answered `{ totalSets: 0, sets: [] }` for every wallet
// — a confident "this collection has no sets", published out of a join that
// matched nothing. That entry is removed in the same commit as this route;
// this is the honest implementation that replaces it.
//
// ── THE KEYS ────────────────────────────────────────────────────────────────
// Verified live 2026-09-20 against the production database:
//   · `pinnacle_catalog` — 2,600 renders, 169 distinct `set_render_id`,
//     **0 rows with a NULL `set_render_id`**, and `set_render_id -> set_name`
//     is **1:1** (0 ids carrying two names). So `set_render_id` is the set key
//     and `set_name` is its label. ⚠ Do NOT key on `set_name`: several carry
//     leading/trailing whitespace (" Lucasfilm Ltd. • Star Wars Alphabet
//     Vol.1", "… Mandalorian Vol.1 ") and would split a set in two.
//   · `wallet_moments_cache` — 50,806 Pinnacle rows over 144 wallets, every one
//     carrying a `render_id`, and **0 owned render_ids absent from the
//     catalog**. So the checklist is a superset of what any wallet holds and
//     "owned but unlisted" is not a state this route has to render.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
// Both reads page with `fetchAllPaged` (PostgREST caps at 1,000 and CLAMPS an
// explicit larger .limit()), and BOTH `truncated` flags are treated as a
// failure rather than a smaller answer: a partial catalog understates
// `totalEditions` (inflating completion) and a partial wallet read understates
// `ownedCount` (deflating it). Either way the number would be wrong while
// looking exactly like a right one, so the route answers 503 instead. Reads are
// bounded (`boundedRead`) and every failure goes through `apiErrorResponse`, so
// a driver message can never reach the page — the Set Tracker renders
// `body.error` verbatim (deep-audit D3).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { fetchAllPaged } from "@/lib/supabase-paginate"
import { classifySetTier, type SetTier } from "@/lib/set-completion-tier"
import { pinnacleRenderHref } from "@/lib/entity-href"
import { normalizeAddress } from "@/lib/address"

export const dynamic = "force-dynamic"
// Above the 8 s per-read bound × the handful of pages each read takes, so the
// lambda cannot die before a bounded read can answer 503 (the pairing
// /api/profile/collection-stats documents).
export const maxDuration = 30

const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

/**
 * How stale the render-grain floor map may be before this route stops quoting a
 * cost to finish a set.
 *
 * ⚠ DERIVED FROM THE WRITER, not copied from a neighbour. `pinnacle_catalog.
 * floor_ask` is rewritten by `pinnacle_catalog_set_floor_asks()`, which runs
 * **daily** (see app/api/cron/pinnacle-sync/route.ts and the 2026-09-13 ask-stamp
 * migration; its stall already has its own alarm arm). 48 h is two missed runs.
 *
 * ⛔ `ASK_STALE_HOURS` (12 h, lib/market/ask-freshness.ts) is deliberately NOT
 * reused here. That constant marks a per-listing ask on a board; against a
 * once-a-day batch writer it would fire on a perfectly healthy lane and every
 * set would read "unpriced" — a suppression whose premise is false, which
 * CLAUDE.md names as its own defect class.
 *
 * The gate is on the map's OWN stamp (`floor_ask_updated_at`), so it cannot go
 * on claiming freshness after the writer stops.
 */
export const PINNACLE_FLOOR_MAP_STALE_HOURS = 48

interface CatalogRow {
  render_id: string
  /** The CHARACTER-grain key: every variant/printing of one pin shares it. */
  shape_render_id: string | null
  set_render_id: string | null
  set_name: string | null
  character_name: string | null
  variant: string | null
  total_minted: number | null
  thumbnail_url: string | null
  floor_ask: number | null
  floor_ask_updated_at: string | null
  fmv_usd: number | null
  fmv_confidence: string | null
  series_name: string | null
}

interface OwnedRow {
  id: string
  render_id: string | null
  serial_number: number | null
  is_locked: boolean | null
}

/** Mirrors the SetsResponse shape the shared Set Tracker client consumes. */
interface Piece {
  playId: string
  playerName: string
  tier: string
  lowestAsk: number | null
  thumbnailUrl: string | null
  topshotUrl: string
  fmv: number | null
  fmvConfidence: string | null
  serialNumber?: number | null
  isLocked?: boolean
}

/** Cap on pieces serialised per set, so one 104-render set cannot dominate. */
const MAX_PIECES_PER_SET = 200

/**
 * A single missing piece counts as a bottleneck when it is the priciest AND it
 * carries more than half the total bill — the same "one piece holding the set
 * hostage" question the shared classifier asks.
 */
const BOTTLENECK_SHARE = 0.5

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!raw) {
    return NextResponse.json(
      { error: "wallet required", code: "bad_request" as const, retryable: false },
      { status: 400 },
    )
  }
  // ⛔ NOT a bare `.toLowerCase()` (CLAUDE.md: "never a bare .toLowerCase(),
  // never a fresh helper" — a grep found ten). `normalizeAddress` folds hex,
  // which is what `wallet_moments_cache.wallet_address` stores for this Flow
  // collection, and leaves a base58 key verbatim. Behaviour on every valid
  // Pinnacle wallet is identical; what it buys is that a Solana key reaching
  // this route is not silently destroyed into a string that matches nothing.
  const wallet = normalizeAddress(raw)

  try {
    // 1. The checklist. Every render in the catalog, paged.
    const catalog = await fetchAllPaged<CatalogRow>(
      (from, to) =>
        boundedRead(
          (supabaseAdmin as any)
            .from("pinnacle_catalog")
            .select(
              "render_id, shape_render_id, set_render_id, set_name, character_name, variant, total_minted, thumbnail_url, floor_ask, floor_ask_updated_at, fmv_usd, fmv_confidence, series_name",
            )
            .not("set_render_id", "is", null)
            .order("render_id", { ascending: true })
            .range(from, to),
          "pinnacle-set-progress/catalog",
        ),
      // 10 pages = a 10,000-row ceiling against 2,600 rows today. SIZED, not
      // guessed: `pinnacle_catalog` grew 140 (Jul) and 188 (Aug) rows/month
      // after June's 2,272-row backfill, so at ~190/month the ceiling is ~39
      // months out. Past it the route 503s (below) rather than shortening the
      // checklist, so the cost of being wrong is an outage, not a lie.
      { pageSize: 1000, maxPages: 10, label: "pinnacle-set-progress/catalog" },
    )
    if (catalog.error) throw catalog.error
    if (catalog.truncated) {
      // A short checklist inflates every completion percentage. Refusing is the
      // only answer that is not silently wrong.
      throw Object.assign(new Error("pinnacle catalog read was truncated"), {
        code: "57014",
      })
    }

    // 2. What this wallet holds. Ordered on the table's uuid PK so paging is
    //    deterministic (an unordered .range() reads the right NUMBER of rows
    //    and the wrong rows, and the duplicates cancel the omissions).
    const owned = await fetchAllPaged<OwnedRow>(
      (from, to) =>
        boundedRead(
          (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("id, render_id, serial_number, is_locked")
            .eq("collection_id", PINNACLE_COLLECTION_ID)
            .eq("wallet_address", wallet)
            .not("render_id", "is", null)
            .order("id", { ascending: true })
            .range(from, to),
          "pinnacle-set-progress/owned",
        ),
      // 30 pages = 30,000 rows. The largest Pinnacle holder measured 2026-09-20
      // is 9,882 rows (1,527 distinct renders), so this is ~3x the real ceiling.
      // ⚠ This reads one row per PIN, not per render — a whale's row count is
      // the number that has to fit, and it is ~6x their distinct renders.
      { pageSize: 1000, maxPages: 30, label: "pinnacle-set-progress/owned" },
    )
    if (owned.error) throw owned.error
    if (owned.truncated) {
      // A short holdings read under-counts owned pieces and would render a
      // whale's finished sets as unfinished.
      throw Object.assign(new Error("pinnacle wallet holdings read was truncated"), {
        code: "57014",
      })
    }

    // Owned render -> its best (lowest) serial and whether that copy is locked.
    const ownedByRender = new Map<string, { serial: number | null; locked: boolean }>()
    for (const o of owned.rows) {
      const rid = o.render_id
      if (!rid) continue
      const prev = ownedByRender.get(rid)
      const serial = o.serial_number
      if (
        !prev ||
        (serial !== null && (prev.serial === null || serial < prev.serial))
      ) {
        ownedByRender.set(rid, { serial, locked: !!o.is_locked })
      }
    }

    // Is the floor map fresh enough to quote a bill? Gate on the map's own
    // newest stamp, so the answer decays with the writer rather than with a
    // hardcoded date.
    let newestAskStamp: number | null = null
    for (const c of catalog.rows) {
      if (c.floor_ask === null || !c.floor_ask_updated_at) continue
      const t = Date.parse(c.floor_ask_updated_at)
      if (Number.isNaN(t)) continue
      if (newestAskStamp === null || t > newestAskStamp) newestAskStamp = t
    }
    const asksEnriched =
      newestAskStamp !== null &&
      Date.now() - newestAskStamp <= PINNACLE_FLOOR_MAP_STALE_HOURS * 3_600_000

    // 3. Group the checklist by set, then by CHARACTER within the set.
    //
    // 🚨 THE SLOT IS THE CHARACTER (`shape_render_id`), NOT THE PRINTING
    // (`render_id`) — corrected 2026-09-20, hours after this route shipped with
    // the wrong one.
    //
    // ── WHY, AND IT IS THE HOUSE RULE NOT A PREFERENCE ────────────────────────
    // `get_topshot_set_progress` counts `COUNT(DISTINCT play_id_onchain)` for
    // both `total_plays` and `owned_plays`. A Top Shot parallel is
    // `setID:playID::subID` — a different EDITION of the SAME play — so every
    // parallel collapses into ONE checklist slot and owning any printing fills
    // it. A 100-play set is 100 slots no matter how many parallels exist.
    // `docs/reference/parallels-variants-data-model.md` records Pinnacle's
    // `variant` as the exact analogue of that parallel axis.
    //
    // Shipping it at render grain made a Pinnacle set of 9 characters × 6
    // variants read as 54 slots, so a collector holding all 9 characters in
    // Standard was told 9/54 = 17% when Top Shot's rule says 100%.
    //
    // ⛔ MEASURED BEFORE FIXING, because "it looks wrong" is not a size:
    // across all 144 Pinnacle wallets, **445 set completions were being shown
    // as unfinished, on 57 wallets** — 981 genuinely complete sets reported as
    // 536. The bug hid **45% of every real completion**. That is the
    // account-level false claim this repo treats as the worst sub-class: telling
    // someone they have not finished something they finished.
    //
    // ⭐ `shape_render_id` is a clean character key, verified live the same day:
    // 918 distinct shapes, **0 carrying more than one character name**, 0 rows
    // missing it, and **0 spanning two sets** — so it cannot merge two
    // characters or leak a slot across sets.
    const bySet = new Map<string, Map<string, CatalogRow[]>>()
    for (const c of catalog.rows) {
      const setKey = c.set_render_id
      // ⚠ Fall back to the render when a shape key is ever absent: a NULL shape
      // must not collapse every such pin in a set into one slot. Measured 0
      // today, but the failure mode is silent and the guard is one `??`.
      const shapeKey = c.shape_render_id ?? c.render_id
      if (!setKey) continue
      const shapes = bySet.get(setKey) ?? new Map<string, CatalogRow[]>()
      const list = shapes.get(shapeKey) ?? []
      list.push(c)
      shapes.set(shapeKey, list)
      bySet.set(setKey, shapes)
    }

    const sets = []
    for (const [setId, shapes] of bySet) {
      const allRows = [...shapes.values()].flat()
      const setName = allRows.find((r) => r.set_name?.trim())?.set_name?.trim() ?? setId

      // Per character: is ANY printing of it held, and which row represents it.
      const ownedShapes: { row: CatalogRow; serial: number | null; locked: boolean }[] = []
      const missingShapes: CatalogRow[] = []
      for (const printings of shapes.values()) {
        const held = printings.filter((r) => ownedByRender.has(r.render_id))
        if (held.length > 0) {
          // Represent the slot with the printing they actually hold; with more
          // than one, the rarest (lowest mint) is the one worth showing.
          const best = held.slice().sort(
            (a, b) => (a.total_minted ?? Number.MAX_SAFE_INTEGER) - (b.total_minted ?? Number.MAX_SAFE_INTEGER),
          )[0]
          const own = ownedByRender.get(best.render_id)!
          ownedShapes.push({ row: best, serial: own.serial, locked: own.locked })
        } else {
          // Represent a missing slot by the CHEAPEST printing — that is what it
          // actually costs to fill it, and which variant a buyer would take.
          missingShapes.push(cheapestPrinting(printings))
        }
      }

      const totalEditions = shapes.size
      const ownedCount = ownedShapes.length
      const missingCount = missingShapes.length
      const completionPct =
        totalEditions > 0 ? Math.round((ownedCount / totalEditions) * 100) : 0

      const lockedOwnedCount = ownedShapes.filter((o) => o.locked).length
      const tradeableOwnedCount = ownedCount - lockedOwnedCount
      const tradeableCompletionPct =
        totalEditions > 0
          ? Math.round((tradeableOwnedCount / totalEditions) * 100)
          : 0

      // Cost to finish = cheapest printing of each missing character. A `null`
      // ask is "nobody is selling one", NOT free.
      const priced = missingShapes
        .map((r) => (r.floor_ask === null ? null : Number(r.floor_ask)))
        .filter((a): a is number => a !== null && a > 0)
      const listedCount = priced.length
      const allPriced = missingCount > 0 && priced.length === missingCount
      const totalMissingCost =
        asksEnriched && priced.length > 0
          ? Number(priced.reduce((a, b) => a + b, 0).toFixed(2))
          : null
      const lowestSingleAsk =
        asksEnriched && priced.length > 0 ? Math.min(...priced) : null

      let bottleneckPrice: number | null = null
      let bottleneckPlayerName: string | null = null
      if (asksEnriched && totalMissingCost !== null && priced.length > 1) {
        let worst: CatalogRow | null = null
        let worstAsk = 0
        for (const r of missingShapes) {
          const a = r.floor_ask === null ? 0 : Number(r.floor_ask)
          if (a > worstAsk) {
            worstAsk = a
            worst = r
          }
        }
        if (worst && worstAsk / totalMissingCost > BOTTLENECK_SHARE) {
          bottleneckPrice = worstAsk
          bottleneckPlayerName = worst.character_name ?? null
        }
      }

      const tier: SetTier = classifySetTier({
        completionPct,
        missingCount,
        estimatedCost: totalMissingCost,
        allPriced: asksEnriched ? allPriced : undefined,
        asksEnriched,
        hasBottleneck: bottleneckPrice !== null,
      })

      sets.push({
        setId,
        setName,
        series: seriesNumber(allRows),
        setTier: null,
        totalEditions,
        ownedCount,
        missingCount,
        listedCount,
        completionPct,
        totalMissingCost,
        lowestSingleAsk,
        bottleneckPrice,
        bottleneckPlayerName,
        tier,
        owned: ownedShapes
          .slice(0, MAX_PIECES_PER_SET)
          .map((o) => toPiece(o.row, ownedByRender)),
        missing: sortMissing(missingShapes)
          .slice(0, MAX_PIECES_PER_SET)
          .map((r) => toPiece(r, ownedByRender)),
        asksEnriched,
        costConfidence: (!asksEnriched ? "low" : allPriced ? "high" : "mixed") as
          | "high"
          | "mixed"
          | "low",
        lockedOwnedCount,
        tradeableOwnedCount,
        tradeableCompletionPct,
        // ⭐ THE VARIANT AXIS, kept as its own number rather than folded into the
        // headline. Completion matches Top Shot's rule (characters), and a
        // collector who chases printings still gets the depth Pinnacle's 13x
        // Standard→premium spread makes worth chasing. Never mix the two: one
        // is "have you finished the set", the other is "how deep do you go".
        totalPrintings: allRows.length,
        ownedPrintings: allRows.filter((r) => ownedByRender.has(r.render_id)).length,
      })
    }

    sets.sort((a, b) => b.completionPct - a.completionPct)

    return NextResponse.json(
      {
        wallet: raw,
        resolvedAddress: wallet,
        totalSets: sets.length,
        completeSets: sets.filter((s) => s.completionPct >= 100).length,
        inProgressSets: sets.filter((s) => s.completionPct > 0 && s.completionPct < 100).length,
        notStartedSets: sets.filter((s) => s.completionPct === 0).length,
        // Surfaced so a reader (and a future instrument) can tell a genuinely
        // cheap set from one whose floor map went stale.
        asksAsOf: newestAskStamp === null ? null : new Date(newestAskStamp).toISOString(),
        sets,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/pinnacle-set-progress", "Failed to load sets.")
  }
}

/** The printing a buyer would actually take to fill a slot: the cheapest live
 *  ask, falling back to the lowest mint when nothing in the slot is listed (so
 *  the row still names a real variant rather than an arbitrary one). */
function cheapestPrinting(printings: CatalogRow[]): CatalogRow {
  let best = printings[0]
  let bestAsk = Number.POSITIVE_INFINITY
  for (const r of printings) {
    const a = r.floor_ask === null ? Number.POSITIVE_INFINITY : Number(r.floor_ask)
    if (a < bestAsk) {
      bestAsk = a
      best = r
    }
  }
  if (bestAsk === Number.POSITIVE_INFINITY) {
    best = printings
      .slice()
      .sort((a, b) => (a.total_minted ?? Number.MAX_SAFE_INTEGER) - (b.total_minted ?? Number.MAX_SAFE_INTEGER))[0]
  }
  return best
}

/** Cheapest-first, then by name — a shopping list, not physical row order. */
function sortMissing(rows: CatalogRow[]): CatalogRow[] {
  return [...rows].sort((a, b) => {
    const aa = a.floor_ask === null ? Number.POSITIVE_INFINITY : Number(a.floor_ask)
    const bb = b.floor_ask === null ? Number.POSITIVE_INFINITY : Number(b.floor_ask)
    if (aa !== bb) return aa - bb
    return (a.character_name ?? "").localeCompare(b.character_name ?? "")
  })
}

function seriesNumber(rows: CatalogRow[]): number | null {
  for (const r of rows) {
    const n = Number(r.series_name)
    if (Number.isFinite(n)) return n
  }
  return null
}

function toPiece(
  r: CatalogRow,
  ownedByRender: Map<string, { serial: number | null; locked: boolean }>,
): Piece {
  const own = ownedByRender.get(r.render_id)
  return {
    playId: r.render_id,
    // ⚠ Never the word "Unknown": that reads as a fact about the pin when it is
    // a fact about our join (lib/entity-href.ts momentSubjectName).
    playerName: r.character_name?.trim() || r.set_name?.trim() || "—",
    // Pinnacle scarcity is a VARIANT, not a tier (lib/collection-tiers.ts) —
    // it occupies the tier slot so the shared card renders a meaningful chip.
    tier: (r.variant ?? "").toUpperCase(),
    lowestAsk: r.floor_ask === null ? null : Number(r.floor_ask),
    thumbnailUrl: r.thumbnail_url,
    // The canonical Pinnacle render page. ⚠ NOT /disney-pinnacle/edition/<id>,
    // which 308s here (app/(collections)/[collection]/edition/[slug]/page.tsx)
    // — linking through the redirect is a hop for the reader and a duplicate
    // URL for the crawler.
    topshotUrl: pinnacleRenderHref(r.render_id),
    fmv: r.fmv_usd === null ? null : Number(r.fmv_usd),
    fmvConfidence: r.fmv_confidence ?? null,
    serialNumber: own?.serial ?? null,
    isLocked: own?.locked ?? false,
  }
}
