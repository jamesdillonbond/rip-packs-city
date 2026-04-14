import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createHash } from "crypto"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const COLLECTION_IDS: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
}

const ALLOWED_TIERS = new Set(["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"])
const DAILY_IP_LIMIT_PER_PACK = 20

function hashIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? ""
  const ip = fwd.split(",")[0]?.trim() || "unknown"
  return createHash("sha256").update(ip).digest("hex").slice(0, 32)
}

export async function GET(req: NextRequest) {
  const packListingId = req.nextUrl.searchParams.get("packListingId") ?? ""
  if (!packListingId) {
    return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
  }

  const { data, error } = await supabase.rpc("get_pack_pull_stats", {
    p_pack_listing_id: packListingId,
  })
  if (error) {
    console.warn(`[pack-pulls] rpc error: ${error.message}`)
    return NextResponse.json({ error: error.message, stats: [] }, { status: 500 })
  }

  return NextResponse.json(
    { packListingId, stats: Array.isArray(data) ? data : [] },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  )
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const packListingId: string = String(body.packListingId ?? "").trim()
  const tierRaw: string = String(body.tier ?? "").toUpperCase().trim()
  const playerName: string | null = body.playerName ? String(body.playerName).slice(0, 120) : null
  const serialRaw = body.serialNumber
  const pricePaidRaw = body.packPricePaid
  const collectionSlug: string = String(body.collection ?? "nba-top-shot")

  if (!packListingId) return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
  if (!ALLOWED_TIERS.has(tierRaw)) return NextResponse.json({ error: "Invalid tier" }, { status: 400 })

  const collectionId = COLLECTION_IDS[collectionSlug]
  if (!collectionId) return NextResponse.json({ error: "Unknown collection" }, { status: 400 })

  const ipHash = hashIp(req)
  const startOfDay = new Date()
  startOfDay.setUTCHours(0, 0, 0, 0)

  const { count, error: countErr } = await supabase
    .from("pack_pull_log")
    .select("*", { count: "exact", head: true })
    .eq("pack_listing_id", packListingId)
    .eq("ip_hash", ipHash)
    .gte("submitted_at", startOfDay.toISOString())
  if (countErr) {
    console.warn(`[pack-pulls] rate-limit check error: ${countErr.message}`)
  } else if ((count ?? 0) >= DAILY_IP_LIMIT_PER_PACK) {
    return NextResponse.json({ error: "Rate limit: max 20 pulls per pack per day" }, { status: 429 })
  }

  const serialNumber = serialRaw != null && serialRaw !== "" ? parseInt(String(serialRaw), 10) : null
  const pricePaid = pricePaidRaw != null && pricePaidRaw !== "" ? parseFloat(String(pricePaidRaw)) : null

  const { error: insertErr } = await supabase.from("pack_pull_log").insert({
    collection_id: collectionId,
    pack_listing_id: packListingId,
    pack_price_paid: pricePaid != null && isFinite(pricePaid) ? pricePaid : null,
    pull_tier: tierRaw,
    pull_player_name: playerName,
    pull_serial_number: Number.isFinite(serialNumber as number) ? serialNumber : null,
    verified: false,
    ip_hash: ipHash,
  })
  if (insertErr) {
    console.warn(`[pack-pulls] insert error: ${insertErr.message}`)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
