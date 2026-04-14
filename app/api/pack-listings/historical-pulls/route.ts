import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

export async function GET(req: NextRequest) {
  const title = req.nextUrl.searchParams.get("title")
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 })

  try {
    // moment_acquisitions doesn't have pack_name — look up by pack_dist_id via a join to pack-title map is costly.
    // Workaround: rely on the `source` or find by matching via wallet_moments_cache set_name ilike.
    // Heuristic: join moment_acquisitions (pack_pull) → wallet_moments_cache on moment_id, count by tier, filter set_name matching title loosely.
    const { data: pulls, error } = await (supabaseAdmin as any)
      .from("moment_acquisitions")
      .select("nft_id, acquisition_method, pack_dist_id, collection_id")
      .eq("collection_id", TOPSHOT_COLLECTION_ID)
      .eq("acquisition_method", "pack_pull")
      .limit(20000)

    if (error || !pulls) {
      return NextResponse.json({ total: 0, tierBreakdown: {} })
    }

    const nftIds: string[] = pulls.map((p: any) => String(p.nft_id)).filter(Boolean)
    if (nftIds.length === 0) return NextResponse.json({ total: 0, tierBreakdown: {} })

    // Batch fetch tiers + set_name from wallet_moments_cache
    const tierCounts: Record<string, number> = {}
    let total = 0
    const BATCH = 500
    const titleLower = title.toLowerCase()
    for (let i = 0; i < nftIds.length; i += BATCH) {
      const slice = nftIds.slice(i, i + BATCH)
      const { data: mom } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, tier, set_name")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("moment_id", slice)
      for (const m of mom ?? []) {
        const sn = (m.set_name ?? "").toLowerCase()
        if (!sn || !titleLower) continue
        // Loose match: any meaningful title token appears in set_name
        const titleTokens = titleLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 4)
        const match = titleTokens.some((tok) => sn.includes(tok))
        if (!match) continue
        const tierLabel = (m.tier ? String(m.tier).replace(/^MOMENT_TIER_/i, "").toUpperCase() : "UNKNOWN")
        tierCounts[tierLabel] = (tierCounts[tierLabel] ?? 0) + 1
        total++
      }
      if (total >= 1000) break
    }

    return NextResponse.json({ total, tierBreakdown: tierCounts })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
