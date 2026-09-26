// app/api/candy-set-progress/route.ts
//
// Candy MLB Set Tracker backend — the Sets tab's Solana arm (2026-09-25).
//
// ── WHY CANDY GETS ITS OWN ROUTE ────────────────────────────────────────────
// The generic /api/sets-db would have worked on the JOIN (Candy's 125 editions
// all carry a `set_id`, and `wallet_moments_cache.edition_key` matches
// `editions.external_id` for every Candy row — 0 orphans, measured 2026-09-25)
// but it is wrong on two counts that matter to a collector:
//
//   1. IT FOLDS THE WALLET. `sets-db` runs `.toLowerCase()` on the address. A
//      Candy key is base58 and CASE-SENSITIVE, so that read matches nothing and
//      the tab would publish "0 of 100" about a wallet holding the whole set —
//      CLAUDE.md's chain-two footgun, failing silently in the wrong direction.
//   2. IT COUNTS PRINTINGS AS SLOTS, and has no price pipeline. Candy's one set
//      is 100 players at /250 plus five of those players in five Rainbow colours
//      at /15 (docs/reference/candy-base-series-checklist-2026-07.csv). Under the
//      house rule — `get_topshot_set_progress` counts DISTINCT plays, so a Top
//      Shot parallel fills the same slot as its base; Pinnacle's route does the
//      same with `shape_render_id` — the checklist is the 100 PLAYERS. Counting
//      125 editions would tell someone holding every player "80%".
//
// ── THE KEYS (verified live 2026-09-25) ─────────────────────────────────────
//   · 125 Candy editions, 100 distinct `player_id`, 0 NULL `player_id`; the five
//     Rainbow players each also have a base edition. So `player_id` is the slot.
//   · `candy_listing_floor` (troll-capped floor per edition, 124 of 125 rows) is
//     the ask; `candy_fmv_current` (latest `fmv_snapshots` row) is the FMV.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · A non-Solana address is REFUSED (400), never answered with zeros: a Flow
//     wallet holds no Candy by construction, and "0 of 100" would be a claim
//     about a wallet we never looked up on this chain (the substitution face).
//   · Truncated or failed reads answer 503 via `apiErrorResponse`, never a
//     smaller checklist (inflates completion) or a smaller holdings list
//     (deflates it).
//   · A cost to finish is quoted only while the floor map is fresh on its OWN
//     stamp — see CANDY_FLOOR_MAP_STALE_HOURS.
//   · A missing slot with no live ask contributes NOTHING to the total and
//     makes `allPriced` false — `null` is "nobody is selling one", not "free".

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { fetchAllPaged } from "@/lib/supabase-paginate"
import { classifySetTier, type SetTier } from "@/lib/set-completion-tier"
import { editionHref } from "@/lib/entity-href"
import { isSolanaAddress } from "@/lib/address"
// The name-suffix derivation the Collection tab already uses — not a fresh copy.
import { parallelFromEditionName } from "@/lib/collection/server-moment"
import { CANDY_PUBLISHED_CHECKLIST_PLAYERS } from "@/lib/chains/solana/candy-checklist"

export const dynamic = "force-dynamic"
// Above the 8 s per-read bound × the handful of reads, so the lambda cannot
// die before a bounded read can answer 503.
export const maxDuration = 30

const CANDY_COLLECTION_ID = "209ade70-32c5-4470-bc7c-4793d660f713"

/**
 * How stale the floor map may be before this route stops quoting a cost.
 *
 * ⚠ DERIVED FROM THE WRITER: `candy_listings` is rewritten by
 * /api/candy-listings-indexer, scheduled `35 *\/3 * * *` in vercel.json — every
 * 3 h. 12 h is four missed ticks, far enough above the healthy cadence that it
 * cannot fire on a working lane. Gated on the map's newest `last_seen_at`, so
 * the answer decays with the writer rather than with a hardcoded date.
 */
export const CANDY_FLOOR_MAP_STALE_HOURS = 12

/** One missing piece is a bottleneck when it carries over half the bill. */
const BOTTLENECK_SHARE = 0.5

const MAX_PIECES_PER_SET = 200

interface EditionRow {
  id: string
  external_id: string | null
  set_id: string | null
  set_name: string | null
  player_id: string | null
  player_name: string | null
  name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
}

interface OwnedRow {
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  is_locked: boolean | null
}

interface Priced {
  ask: number | null
  fmv: number | null
  confidence: string | null
}

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

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("wallet")?.trim() ?? ""
  if (!raw) {
    return NextResponse.json(
      { error: "wallet required", code: "bad_request" as const, retryable: false },
      { status: 400 },
    )
  }
  // ⛔ Verbatim — never folded. A base58 key is case-sensitive.
  if (!isSolanaAddress(raw)) {
    return NextResponse.json(
      {
        error: "Candy MLB lives on Solana — enter a Solana wallet address.",
        code: "bad_request" as const,
        retryable: false,
      },
      { status: 400 },
    )
  }
  const wallet = raw

  try {
    const [edRes, setRes, fmvRes, floorRes, owned] = await Promise.all([
      fetchAllPaged<EditionRow>(
        (from, to) =>
          boundedRead(
            (supabaseAdmin as any)
              .from("editions")
              .select(
                "id, external_id, set_id, set_name, player_id, player_name, name, tier, circulation_count, thumbnail_url",
              )
              .eq("collection_id", CANDY_COLLECTION_ID)
              .not("set_id", "is", null)
              .order("id", { ascending: true })
              .range(from, to),
            "candy-set-progress/editions",
          ),
        // 125 rows today; 5 pages is 40x headroom and past it we 503.
        { pageSize: 1000, maxPages: 5, label: "candy-set-progress/editions" },
      ),
      boundedRead(
        (supabaseAdmin as any)
          .from("sets")
          .select("id, name, series")
          .eq("collection_id", CANDY_COLLECTION_ID),
        "candy-set-progress/sets",
      ),
      boundedRead(
        (supabaseAdmin as any).from("candy_fmv_current").select("edition_id, fmv_usd, confidence"),
        "candy-set-progress/fmv",
      ),
      boundedRead(
        (supabaseAdmin as any)
          .from("candy_listing_floor")
          .select("edition_id, floor_usd, last_seen_at"),
        "candy-set-progress/floor",
      ),
      fetchAllPaged<OwnedRow>(
        (from, to) =>
          boundedRead(
            (supabaseAdmin as any)
              .from("wallet_moments_cache")
              .select("moment_id, edition_key, serial_number, is_locked")
              .eq("collection_id", CANDY_COLLECTION_ID)
              .eq("wallet_address", wallet)
              .order("moment_id", { ascending: true })
              .range(from, to),
            "candy-set-progress/owned",
          ),
        // The largest Candy holder measured 2026-09-25 holds 1,896 rows, so
        // 20 pages (20,000) is ~10x the real ceiling.
        { pageSize: 1000, maxPages: 20, label: "candy-set-progress/owned" },
      ),
    ])

    if (edRes.error) throw new Error(edRes.error)
    if (edRes.truncated) {
      throw Object.assign(new Error("candy checklist read was truncated"), { code: "57014" })
    }
    if (owned.error) throw new Error(owned.error)
    if (owned.truncated) {
      throw Object.assign(new Error("candy holdings read was truncated"), { code: "57014" })
    }
    if (setRes.error) throw setRes.error
    // A failed PRICE read degrades to "unpriced", never to a failed tracker and
    // never to a $0 bill: completion is still exact without it.
    const fmvOk = !fmvRes.error
    const floorOk = !floorRes.error
    if (fmvRes.error) console.error("[candy-set-progress] fmv read failed:", fmvRes.error)
    if (floorRes.error) console.error("[candy-set-progress] floor read failed:", floorRes.error)

    const price = new Map<string, Priced>()
    const slot = (id: string): Priced => {
      let p = price.get(id)
      if (!p) {
        p = { ask: null, fmv: null, confidence: null }
        price.set(id, p)
      }
      return p
    }
    if (fmvOk) {
      for (const r of (fmvRes.data ?? []) as { edition_id: string; fmv_usd: unknown; confidence: string | null }[]) {
        const p = slot(r.edition_id)
        p.fmv = num(r.fmv_usd)
        p.confidence = r.confidence ?? null
      }
    }
    let newestAskStamp: number | null = null
    if (floorOk) {
      for (const r of (floorRes.data ?? []) as { edition_id: string; floor_usd: unknown; last_seen_at: string | null }[]) {
        const ask = num(r.floor_usd)
        slot(r.edition_id).ask = ask !== null && ask > 0 ? ask : null
        const t = r.last_seen_at ? Date.parse(r.last_seen_at) : NaN
        if (!Number.isNaN(t) && (newestAskStamp === null || t > newestAskStamp)) newestAskStamp = t
      }
    }
    const asksEnriched =
      floorOk &&
      newestAskStamp !== null &&
      Date.now() - newestAskStamp <= CANDY_FLOOR_MAP_STALE_HOURS * 3_600_000

    const setMeta = new Map<string, { name: string | null; series: number | null }>()
    for (const s of (setRes.data ?? []) as { id: string; name: string | null; series: number | null }[]) {
      setMeta.set(s.id, { name: s.name, series: s.series ?? null })
    }

    // Owned edition external_id -> its best (lowest) serial and lock state.
    const ownedByExt = new Map<string, { serial: number | null; locked: boolean }>()
    for (const o of owned.rows) {
      const k = o.edition_key
      if (!k) continue
      const prev = ownedByExt.get(k)
      const s = o.serial_number
      if (!prev || (s !== null && (prev.serial === null || s < prev.serial))) {
        ownedByExt.set(k, { serial: s, locked: !!o.is_locked })
      }
    }
    const isOwned = (e: EditionRow) => !!e.external_id && ownedByExt.has(e.external_id)

    // set -> player slot -> printings
    const bySet = new Map<string, Map<string, EditionRow[]>>()
    for (const e of edRes.rows) {
      if (!e.set_id) continue
      // A NULL player_id must not collapse every such card into one slot.
      const slotKey = e.player_id ?? `edition:${e.id}`
      const slots = bySet.get(e.set_id) ?? new Map<string, EditionRow[]>()
      const list = slots.get(slotKey) ?? []
      list.push(e)
      slots.set(slotKey, list)
      bySet.set(e.set_id, slots)
    }

    const askOf = (e: EditionRow) => price.get(e.id)?.ask ?? null

    const toPiece = (e: EditionRow): Piece => {
      const own = e.external_id ? ownedByExt.get(e.external_id) : undefined
      const p = price.get(e.id)
      const parallel = parallelFromEditionName(e.name, e.player_name)?.toUpperCase() ?? null
      return {
        playId: e.id,
        playerName: e.player_name?.trim() || e.name?.trim() || "—",
        // Name the printing: "BASE" alone would hide which Rainbow colour this is.
        tier: parallel ?? (e.tier ?? "COMMON").toUpperCase(),
        lowestAsk: asksEnriched ? (p?.ask ?? null) : null,
        thumbnailUrl: e.thumbnail_url,
        topshotUrl: editionHref("candy-mlb", e.external_id, e.id),
        fmv: p?.fmv ?? null,
        fmvConfidence: p?.confidence ?? null,
        serialNumber: own?.serial ?? null,
        isLocked: own?.locked ?? false,
      }
    }

    const sets = []
    for (const [setId, slots] of bySet) {
      const allRows = [...slots.values()].flat()
      const meta = setMeta.get(setId)
      const setName = meta?.name?.trim() || allRows.find((r) => r.set_name?.trim())?.set_name?.trim() || setId

      const ownedSlots: EditionRow[] = []
      const missingSlots: EditionRow[] = []
      for (const printings of slots.values()) {
        const held = printings.filter(isOwned)
        if (held.length > 0) {
          // Show the rarest printing they hold (a /15 Rainbow over a /250 base).
          ownedSlots.push(
            held.slice().sort(
              (a, b) => (a.circulation_count ?? Number.MAX_SAFE_INTEGER) - (b.circulation_count ?? Number.MAX_SAFE_INTEGER),
            )[0],
          )
        } else {
          missingSlots.push(cheapestPrinting(printings, askOf))
        }
      }

      const totalEditions = slots.size
      const ownedCount = ownedSlots.length
      const missingCount = missingSlots.length
      const completionPct = totalEditions > 0 ? Math.round((ownedCount / totalEditions) * 100) : 0
      const lockedOwnedCount = ownedSlots.filter((e) => e.external_id && ownedByExt.get(e.external_id)?.locked).length
      const tradeableOwnedCount = ownedCount - lockedOwnedCount
      const tradeableCompletionPct =
        totalEditions > 0 ? Math.round((tradeableOwnedCount / totalEditions) * 100) : 0

      const priced = missingSlots.map(askOf).filter((a): a is number => a !== null && a > 0)
      const listedCount = asksEnriched ? priced.length : 0
      const allPriced = missingCount > 0 && priced.length === missingCount
      const totalMissingCost =
        asksEnriched && priced.length > 0 ? Number(priced.reduce((a, b) => a + b, 0).toFixed(2)) : null
      const lowestSingleAsk = asksEnriched && priced.length > 0 ? Math.min(...priced) : null

      let bottleneckPrice: number | null = null
      let bottleneckPlayerName: string | null = null
      if (asksEnriched && totalMissingCost !== null && priced.length > 1) {
        let worst: EditionRow | null = null
        let worstAsk = 0
        for (const e of missingSlots) {
          const a = askOf(e) ?? 0
          if (a > worstAsk) {
            worstAsk = a
            worst = e
          }
        }
        if (worst && worstAsk / totalMissingCost > BOTTLENECK_SHARE) {
          bottleneckPrice = worstAsk
          bottleneckPlayerName = worst.player_name ?? null
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
        series: meta?.series ?? null,
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
        owned: ownedSlots.slice(0, MAX_PIECES_PER_SET).map(toPiece),
        missing: sortMissing(missingSlots, askOf).slice(0, MAX_PIECES_PER_SET).map(toPiece),
        asksEnriched,
        costConfidence: (!asksEnriched ? "low" : allPriced ? "high" : "mixed") as "high" | "mixed" | "low",
        lockedOwnedCount,
        tradeableOwnedCount,
        tradeableCompletionPct,
        // THE PARALLEL AXIS, beside completion and never folded into it: the
        // Rainbow printings are depth, not checklist slots.
        totalPrintings: allRows.length,
        ownedPrintings: allRows.filter(isOwned).length,
      })
    }

    sets.sort((a, b) => b.completionPct - a.completionPct)

    // Candy's PUBLISHED checklist can name players RPC has never seen a minted
    // card for (3 on 2026-09-25). Computed live against the catalog read above,
    // so the list empties itself when a card for one of them is indexed.
    const norm = (n: string) => n.normalize("NFC").trim().toLowerCase()
    const seenPlayers = new Set(edRes.rows.map((e) => norm(e.player_name ?? "")).filter(Boolean))
    const notIndexed = CANDY_PUBLISHED_CHECKLIST_PLAYERS.filter((n) => !seenPlayers.has(norm(n)))

    return NextResponse.json(
      {
        wallet: raw,
        resolvedAddress: wallet,
        totalSets: sets.length,
        completeSets: sets.filter((s) => s.completionPct >= 100).length,
        inProgressSets: sets.filter((s) => s.completionPct > 0 && s.completionPct < 100).length,
        notStartedSets: sets.filter((s) => s.completionPct === 0).length,
        asksAsOf: newestAskStamp === null ? null : new Date(newestAskStamp).toISOString(),
        publishedChecklist: { total: CANDY_PUBLISHED_CHECKLIST_PLAYERS.length, notIndexed },
        sets,
        generatedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/candy-set-progress", "Failed to load sets.")
  }
}

/** The printing a buyer would take to fill a slot: the cheapest live ask,
 *  falling back to the most common printing (the base card) when none is listed. */
function cheapestPrinting(printings: EditionRow[], askOf: (e: EditionRow) => number | null): EditionRow {
  let best: EditionRow | null = null
  let bestAsk = Number.POSITIVE_INFINITY
  for (const e of printings) {
    const a = askOf(e)
    if (a !== null && a < bestAsk) {
      bestAsk = a
      best = e
    }
  }
  if (best) return best
  return printings
    .slice()
    .sort((a, b) => (b.circulation_count ?? 0) - (a.circulation_count ?? 0))[0]
}

/** Cheapest-first, then by name — a shopping list. */
function sortMissing(rows: EditionRow[], askOf: (e: EditionRow) => number | null): EditionRow[] {
  return [...rows].sort((a, b) => {
    const aa = askOf(a) ?? Number.POSITIVE_INFINITY
    const bb = askOf(b) ?? Number.POSITIVE_INFINITY
    if (aa !== bb) return aa - bb
    return (a.player_name ?? "").localeCompare(b.player_name ?? "")
  })
}
