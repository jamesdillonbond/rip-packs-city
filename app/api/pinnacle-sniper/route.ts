// app/api/pinnacle-sniper/route.ts
// GET /api/pinnacle-sniper — Disney Pinnacle sniper deals
// Queries pinnacle_editions joined with pinnacle_fmv_snapshots for FMV-aware deals

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  try {
    // Check if pinnacle_editions table has an ask_price column
    const { data: columns } = await supabase
      .from("information_schema.columns" as any)
      .select("column_name")
      .eq("table_schema", "public")
      .eq("table_name", "pinnacle_editions")

    const columnNames = (columns ?? []).map((c: any) => c.column_name)

    if (!columnNames.includes("ask_price")) {
      // No ask price column — return empty with message
      return NextResponse.json({
        count: 0,
        deals: [],
        message: "Pinnacle ask data is not yet synced. The ask_price column does not exist on pinnacle_editions.",
        lastRefreshed: new Date().toISOString(),
      })
    }

    // Query pinnacle editions with ask prices
    const { data: editions, error } = await supabase
      .from("pinnacle_editions")
      .select("*")
      .not("ask_price", "is", null)
      .gt("ask_price", 0)
      .order("ask_price", { ascending: true })
      .limit(200)

    if (error) throw new Error(error.message)

    // Try to get FMV data from pinnacle_fmv_snapshots
    const editionIds = (editions ?? []).map((e: any) => e.id)
    let fmvMap = new Map<string, number>()

    if (editionIds.length > 0) {
      const { data: fmvRows } = await supabase
        .from("pinnacle_fmv_snapshots")
        .select("edition_id, fmv_usd")
        .in("edition_id", editionIds)
        .order("computed_at", { ascending: false })

      for (const row of fmvRows ?? []) {
        if (!fmvMap.has(row.edition_id)) {
          fmvMap.set(row.edition_id, row.fmv_usd)
        }
      }
    }

    // Build SniperDeal-shaped objects
    const deals = (editions ?? []).map((e: any) => {
      const fmv = fmvMap.get(e.id) ?? e.fmv_usd ?? null
      const askPrice = Number(e.ask_price)
      const discount = fmv && fmv > 0 ? Math.round(((fmv - askPrice) / fmv) * 100) : 0

      return {
        flowId: e.id ?? e.external_id ?? String(Math.random()),
        momentId: e.id ?? "",
        editionKey: e.external_id ?? e.id ?? "",
        playerName: e.name ?? e.character_name ?? "Unknown",
        teamName: e.franchise ?? e.collection_name ?? "Disney Pinnacle",
        setName: e.set_name ?? "Pinnacle",
        seriesName: e.series ?? "",
        tier: e.tier ?? e.rarity ?? "Common",
        parallel: "Base",
        parallelId: 0,
        serial: e.serial_number ?? 0,
        circulationCount: e.circulation_count ?? e.edition_size ?? 0,
        askPrice,
        baseFmv: fmv ?? askPrice,
        adjustedFmv: fmv ?? askPrice,
        wapUsd: null,
        daysSinceSale: null,
        salesCount30d: null,
        discount,
        confidence: fmv ? "medium" : "low",
        hasBadge: false,
        badgeSlugs: [],
        badgeLabels: [],
        badgePremiumPct: 0,
        serialMult: 1,
        isSpecialSerial: false,
        isJersey: false,
        serialSignal: null,
        thumbnailUrl: e.image_url ?? e.thumbnail_url ?? null,
        isLocked: false,
        updatedAt: e.updated_at ?? new Date().toISOString(),
        packListingId: null,
        packName: null,
        packEv: null,
        packEvRatio: null,
        buyUrl: `https://disneypinnacle.com/marketplace`,
        listingResourceID: null,
        storefrontAddress: null,
        source: "pinnacle" as const,
      }
    })

    return NextResponse.json({
      count: deals.length,
      deals,
      lastRefreshed: new Date().toISOString(),
    })
  } catch (err: any) {
    // If the table doesn't exist at all, return gracefully
    return NextResponse.json({
      count: 0,
      deals: [],
      message: err.message?.includes("does not exist")
        ? "Pinnacle tables are not yet provisioned."
        : err.message,
      lastRefreshed: new Date().toISOString(),
    })
  }
}
