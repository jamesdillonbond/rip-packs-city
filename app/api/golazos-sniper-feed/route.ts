import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { createClient } from "@supabase/supabase-js"
import { getClubAbbrev } from "@/lib/laliga-clubs"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"

const GOLAZOS_TIERS = ["COMMON", "FANDOM", "UNCOMMON", "RARE", "LEGENDARY"] as const

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = req.nextUrl
    const minDiscount = Number(url.searchParams.get("minDiscount") ?? "0") || 0
    const tier = (url.searchParams.get("tier") || "").toUpperCase()
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "200") || 200, 500)

    let q = supabase
      .from("cached_listings")
      .select("*")
      .eq("collection_id", GOLAZOS_COLLECTION_ID)
      .eq("source", "flowty")
      .gt("ask_price", 0)
      .order("listed_at", { ascending: false })
      .limit(limit * 2)

    if (tier && (GOLAZOS_TIERS as readonly string[]).includes(tier)) {
      q = q.eq("tier", tier)
    }

    const { data: listings, error } = await q
    if (error) {
      return apiErrorResponse(error, "api/golazos-sniper-feed");
    }
    const rows: any[] = listings ?? []

    // FMV lookup via editions table keyed on player_name + set_name, then join
    // to fmv_snapshots (latest per edition) for the ASK_ONLY snapshot.
    const editionKeys = new Set<string>()
    for (const r of rows) {
      if (r.player_name && r.set_name) {
        editionKeys.add(`${String(r.player_name).trim()}|${String(r.set_name).trim()}`)
      }
    }

    const edByKey = new Map<string, { id: string; circ: number | null; series: number | null; tier: string | null }>()
    if (editionKeys.size > 0) {
      const playerNames = [...new Set(rows.map(r => r.player_name).filter(Boolean))]
      for (let i = 0; i < playerNames.length; i += 200) {
        const chunk = playerNames.slice(i, i + 200)
        const { data: eds } = await boundedRead(supabase
          .from("editions")
          .select("id, player_name, set_name, circulation_count, series, tier")
          .eq("collection_id", GOLAZOS_COLLECTION_ID)
          .in("player_name", chunk), "api/golazos-sniper-feed/editions")
        for (const e of eds ?? []) {
          const key = `${String(e.player_name).trim()}|${String(e.set_name).trim()}`
          edByKey.set(key, {
            id: e.id,
            circ: e.circulation_count ?? null,
            series: e.series ?? null,
            tier: e.tier ?? null,
          })
        }
      }
    }

    const editionIds = [...new Set([...edByKey.values()].map(e => e.id))]
    const fmvById = new Map<string, { fmv: number | null; confidence: string }>()
    for (let i = 0; i < editionIds.length; i += 200) {
      const chunk = editionIds.slice(i, i + 200)
      // fmv_current = DISTINCT-ON latest-per-edition (1 row/edition), avoiding the
      // raw-fmv_snapshots DESC 1000-row-cap drop of cold editions.
      const { data: snaps } = await boundedRead(supabase
        .from("fmv_current")
        .select("edition_id, fmv_usd, confidence, computed_at")
        .in("edition_id", chunk), "api/golazos-sniper-feed/fmv_current")
      for (const s of snaps ?? []) {
        if (!fmvById.has(s.edition_id)) {
          const raw = s.fmv_usd == null ? NaN : Number(s.fmv_usd)
          fmvById.set(s.edition_id, {
            fmv: Number.isFinite(raw) ? raw : null,
            confidence: String(s.confidence || "LOW"),
          })
        }
      }
    }

    const deals = rows.map((r: any) => {
      const key = r.player_name && r.set_name
        ? `${String(r.player_name).trim()}|${String(r.set_name).trim()}`
        : ""
      const ed = key ? edByKey.get(key) : undefined
      const fmvRow = ed ? fmvById.get(ed.id) : undefined
      // An unknown FMV stays NULL. This used to be `... ?? 0) || 0`, so every
      // Golazos listing without a snapshot shipped `baseFmv: 0` — which renders
      // as a literal $0.00 fair value, and any consumer dividing by it gets
      // Infinity (and a bogus trend arrow). Null is the honest signal and the
      // UI renders an em-dash for it. (2026-07-25)
      const rawFmv = r.fmv ?? fmvRow?.fmv ?? null
      const fmvNum = rawFmv == null ? NaN : Number(rawFmv)
      const baseFmv: number | null = Number.isFinite(fmvNum) && fmvNum > 0 ? fmvNum : null
      const adjustedFmv = baseFmv
      const askPrice = Number(r.ask_price) || 0
      const discount = baseFmv != null ? ((baseFmv - askPrice) / baseFmv) * 100 : 0
      const confidence = r.confidence || fmvRow?.confidence || "LOW"

      return {
        flowId: String(r.flow_id || ""),
        momentId: String(r.moment_id || ""),
        editionKey: ed?.id ?? "",
        intEditionKey: ed?.id ?? null,
        playerName: r.player_name || "",
        teamName: getClubAbbrev(r.team_name || ""),
        setName: r.set_name || "",
        seriesName: r.series_name || "",
        tier: String(r.tier || "COMMON").toUpperCase(),
        parallel: "Base",
        parallelId: 0,
        serial: Number(r.serial_number) || 0,
        circulationCount: Number(r.circulation_count ?? ed?.circ ?? 0) || 0,
        askPrice,
        baseFmv,
        adjustedFmv,
        aspUsd: null,
        daysSinceSale: null,
        salesCount30d: null,
        discount: Math.round(discount * 100) / 100,
        confidence,
        confidenceSource: "flowty",
        hasBadge: false,
        badgeSlugs: [],
        badgeLabels: [],
        badgePremiumPct: 0,
        serialMult: 1,
        isSpecialSerial: false,
        isJersey: false,
        serialSignal: null,
        thumbnailUrl: r.thumbnail_url || null,
        isLocked: Boolean(r.is_locked),
        updatedAt: r.listed_at || r.cached_at || null,
        packListingId: null,
        packName: null,
        packEv: null,
        packEvRatio: null,
        buyUrl: r.buy_url || "",
        listingResourceID: r.listing_resource_id || null,
        listingOrderID: null,
        storefrontAddress: r.storefront_address || null,
        source: "flowty" as const,
        paymentToken: "DUC" as const,
        offerAmount: null,
        offerFmvPct: null,
        dealRating: 0,
        isLowestAsk: false,
      }
    })

    const filtered = deals
      .filter(d => d.askPrice > 0)
      .filter(d => minDiscount === 0 || d.discount >= minDiscount)
      .slice(0, limit)

    return NextResponse.json({
      count: filtered.length,
      tsCount: 0,
      flowtyCount: filtered.length,
      lastRefreshed: new Date().toISOString(),
      deals: filtered,
      elapsed: Date.now() - t0,
    })
  } catch (e: any) {
    return apiErrorResponse(e, "api/golazos-sniper-feed")
  }
}
