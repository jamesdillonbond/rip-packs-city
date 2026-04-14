import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

const TIER_ENUM = new Set(["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"])

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function normalizeTier(raw: string | undefined): string {
  const t = (raw ?? "").toUpperCase().trim()
  if (TIER_ENUM.has(t)) return t
  if (t === "FANDOM") return "UNCOMMON"
  if (t.includes("COMMON")) return "COMMON"
  if (t.includes("UNCOMMON")) return "UNCOMMON"
  if (t.includes("LEGEND")) return "LEGENDARY"
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("RARE")) return "RARE"
  return "COMMON"
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const started = Date.now()

  // 1. Fetch editions
  const editionRows: any[] = []
  {
    const pageSize = 1000
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("editions")
        .select("id, external_id, set_name, tier, series, player_name")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .range(from, from + pageSize - 1)
      if (error) {
        console.log(`[allday-pack-listings] editions fetch error: ${error.message}`)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      if (!data || data.length === 0) break
      editionRows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }
  console.log(`[allday-pack-listings] Loaded ${editionRows.length} editions`)

  // 2. Fetch cached_listings
  const listingRows: any[] = []
  {
    const pageSize = 1000
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("cached_listings")
        .select("id, set_name, tier, ask_price, thumbnail_url, collection_id")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .range(from, from + pageSize - 1)
      if (error) {
        console.log(`[allday-pack-listings] cached_listings fetch error: ${error.message}`)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      if (!data || data.length === 0) break
      listingRows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }
  console.log(`[allday-pack-listings] Loaded ${listingRows.length} cached listings`)

  // 3. Build set_name:tier → lowest ask + image + count
  const lowestByGroup = new Map<string, { ask: number; image: string | null; count: number }>()
  for (const row of listingRows) {
    const ask = parseFloat(String(row.ask_price ?? "0"))
    if (!isFinite(ask) || ask <= 0) continue
    const setName: string = (row.set_name ?? "").toString().trim()
    if (!setName) continue
    const tier = normalizeTier(row.tier)
    const key = `${setName}::${tier}`
    const prev = lowestByGroup.get(key)
    if (!prev) {
      lowestByGroup.set(key, { ask, image: row.thumbnail_url ?? null, count: 1 })
    } else {
      prev.count++
      if (ask < prev.ask) prev.ask = ask
      if (!prev.image && row.thumbnail_url) prev.image = row.thumbnail_url
    }
  }

  // 4. Group editions by (set_name, tier)
  type Group = {
    setName: string
    tier: string
    series: number | string | null
    editionCount: number
    listedCount: number
    lowestAsk: number | null
    image: string | null
  }
  const groups = new Map<string, Group>()

  for (const ed of editionRows) {
    const setName: string = (ed.set_name ?? "").toString().trim()
    if (!setName) continue
    const tier = normalizeTier(ed.tier)
    const key = `${setName}::${tier}`
    let g = groups.get(key)
    if (!g) {
      g = { setName, tier, series: ed.series ?? null, editionCount: 0, listedCount: 0, lowestAsk: null, image: null }
      groups.set(key, g)
    }
    g.editionCount++
  }

  for (const [key, g] of groups) {
    const listing = lowestByGroup.get(key)
    if (listing) {
      g.listedCount = listing.count
      g.lowestAsk = listing.ask
      if (!g.image && listing.image) g.image = listing.image
    }
  }

  const groupsFound = groups.size
  const groupsWithListings = Array.from(groups.values()).filter((g) => g.listedCount > 0).length

  const now = new Date().toISOString()
  const rows = Array.from(groups.values())
    .map((g) => {
      const packName = `${g.setName} — ${g.tier}`
      return {
        id: `allday:${slug(`${g.setName}-${g.tier}`)}`,
        collection_id: ALLDAY_COLLECTION_ID,
        pack_name: packName,
        tier: g.tier,
        pack_type: "standard",
        lowest_ask_usd: g.lowestAsk != null ? Math.round(g.lowestAsk * 100) / 100 : null,
        total_listed: g.listedCount,
        moments_per_pack: null as number | null,
        image_url: g.image,
        source: "flowty",
        cached_at: now,
        first_seen_at: now,
        metadata: { edition_count: g.editionCount, series: g.series },
      }
    })

  console.log(`[allday-pack-listings] ${groupsFound} groups, ${groupsWithListings} with listings`)

  const del = await supabase
    .from("pack_listings_cache")
    .delete()
    .eq("collection_id", ALLDAY_COLLECTION_ID)
  if (del.error) console.log(`[allday-pack-listings] delete error: ${del.error.message}`)

  let inserted = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { error } = await supabase.from("pack_listings_cache").upsert(chunk, { onConflict: "id" })
    if (error) console.log(`[allday-pack-listings] upsert error: ${error.message}`)
    else inserted += chunk.length
  }

  return NextResponse.json({
    ok: true,
    groups_found: groupsFound,
    groups_with_listings: groupsWithListings,
    cached: inserted,
    elapsed: Date.now() - started,
  })
}

export async function GET() {
  const { data, error } = await supabase.rpc("get_pack_listings_by_collection", {
    p_collection_id: ALLDAY_COLLECTION_ID,
  })
  if (error) {
    console.warn(`[allday-pack-listings] rpc error: ${error.message}`)
    return NextResponse.json({ error: error.message, listings: [] }, { status: 500 })
  }
  const rows: any[] = Array.isArray(data) ? data : []

  const listings = rows.map((r: any) => ({
    packListingId: r.id,
    distId: r.id,
    title: r.pack_name,
    tier: String(r.tier ?? "common").toLowerCase(),
    imageUrl: r.image_url ?? "",
    momentsPerPack: r.moments_per_pack ?? 1,
    retailPrice: Number(r.retail_price_usd ?? 0),
    lowestAsk: Number(r.lowest_ask_usd ?? 0),
    startTime: r.first_seen_at ?? r.cached_at ?? new Date().toISOString(),
    listingCount: Number(r.total_listed ?? 0),
    packType: "standard" as const,
    seriesLabel: null,
  }))

  return NextResponse.json({ listings })
}
