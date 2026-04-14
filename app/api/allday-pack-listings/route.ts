import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0xe4cf4bdc1751c65d/AllDay"
const FLOWTY_HEADERS = {
  "Content-Type": "application/json",
  Origin: "https://www.flowty.io",
  Referer: "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}
const PAGE_OFFSETS = [0, 24, 48]
const PAGE_LIMIT = 100

const TIER_ENUM = new Set(["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"])

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function normalizeTier(raw: string | undefined): string {
  const t = (raw ?? "").toUpperCase().trim()
  if (TIER_ENUM.has(t)) return t
  if (t.includes("COMMON")) return "COMMON"
  if (t.includes("UNCOMMON")) return "UNCOMMON"
  if (t.includes("LEGEND")) return "LEGENDARY"
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("RARE")) return "RARE"
  return "COMMON"
}

function getTrait(traits: any[], ...names: string[]): string {
  if (!Array.isArray(traits)) return ""
  for (const name of names) {
    const t = traits.find((tr: any) => tr && (tr.name === name || tr.trait_type === name))
    if (t && t.value != null && String(t.value).trim() !== "") return String(t.value).trim()
  }
  return ""
}

async function fetchFlowtyPage(offset: number): Promise<any[]> {
  try {
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({ filters: {}, offset, limit: PAGE_LIMIT }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.log(`[allday-pack-listings] Flowty offset=${offset} HTTP ${res.status}`)
      return []
    }
    const json = await res.json()
    const items = json.nfts ?? json.data ?? []
    return Array.isArray(items) ? items : []
  } catch (e: any) {
    console.log(`[allday-pack-listings] Flowty offset=${offset} error: ${e?.message ?? "unknown"}`)
    return []
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const started = Date.now()
  const pages = await Promise.all(PAGE_OFFSETS.map(fetchFlowtyPage))
  const allNfts = pages.flat()
  console.log(`[allday-pack-listings] Fetched ${allNfts.length} raw NFTs from Flowty`)

  type Group = { setName: string; tier: string; nfts: Array<{ price: number; image: string | null }> }
  const groups = new Map<string, Group>()

  for (const nft of allNfts) {
    const orders = Array.isArray(nft?.orders) ? nft.orders : []
    const listed = orders.find((o: any) => o?.state === "LISTED")
    if (!listed) continue
    const price = parseFloat(String(listed.salePrice ?? "0"))
    if (!isFinite(price) || price <= 0) continue

    let traits: any[] = []
    if (nft.nftView?.traits) {
      if (Array.isArray(nft.nftView.traits)) traits = nft.nftView.traits
      else if (Array.isArray(nft.nftView.traits.traits)) traits = nft.nftView.traits.traits
    }

    const setName = getTrait(traits, "SetName", "setName", "Set Name")
    const tierRaw = getTrait(traits, "Tier", "editionTier", "Moment Tier")
    if (!setName || !tierRaw) continue
    const tier = normalizeTier(tierRaw)

    const image: string | null =
      (nft?.card && Array.isArray(nft.card.images) && nft.card.images[0]?.url) || null

    const key = `${setName}::${tier}`
    let g = groups.get(key)
    if (!g) {
      g = { setName, tier, nfts: [] }
      groups.set(key, g)
    }
    g.nfts.push({ price, image })
  }

  const now = new Date().toISOString()
  const rows = Array.from(groups.values())
    .filter((g) => g.nfts.length > 0)
    .map((g) => {
      const lowest = g.nfts.reduce((m, n) => (n.price < m ? n.price : m), Infinity)
      const image = g.nfts.find((n) => n.image)?.image ?? null
      const packName = `${g.setName} — ${g.tier}`
      return {
        id: `allday:${slug(packName)}`,
        collection_id: ALLDAY_COLLECTION_ID,
        pack_name: packName,
        tier: g.tier,
        pack_type: "standard",
        lowest_ask_usd: Math.round(lowest * 100) / 100,
        total_listed: g.nfts.length,
        image_url: image,
        source: "flowty",
        cached_at: now,
        first_seen_at: now,
      }
    })

  console.log(`[allday-pack-listings] Grouped ${rows.length} synthetic packs`)

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
    fetched: allNfts.length,
    groups: rows.length,
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
