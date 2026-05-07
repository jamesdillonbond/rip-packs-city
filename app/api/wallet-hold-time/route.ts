// app/api/wallet-hold-time/route.ts
//
// GET /api/wallet-hold-time?wallet=0x...|username&collection=<slug>
// Buckets a wallet's TopShot acquisitions by hold time. Non-TopShot returns
// an empty payload with reason='acquisition_data_unavailable' (200, not 404)
// so the consuming card can hide gracefully.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

const BUCKET_ORDER = ["0-30d", "30-90d", "90-180d", "180-365d", "365d+"] as const
type Bucket = (typeof BUCKET_ORDER)[number]

type UsernameProfileResponse = {
  getUserProfileByUsername?: { publicInfo?: { flowAddress?: string | null } | null } | null
}

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  if (t.startsWith("0x") && t.length === 18) return t
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: t.replace(/^@+/, "") })
  const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!raw) throw new Error("Could not resolve username to wallet address.")
  return raw.startsWith("0x") ? raw : `0x${raw}`
}

function bucketFor(daysAgo: number): Bucket {
  if (daysAgo < 30) return "0-30d"
  if (daysAgo < 90) return "30-90d"
  if (daysAgo < 180) return "90-180d"
  if (daysAgo < 365) return "180-365d"
  return "365d+"
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || ""
    const collectionUuid = COLLECTION_UUID_BY_SLUG[collectionSlug]
    if (!collectionUuid) {
      return NextResponse.json({ error: `unknown collection: ${collectionSlug}` }, { status: 400 })
    }

    const wallet = await resolveWallet(walletInput)

    if (collectionUuid !== TOPSHOT_UUID) {
      return NextResponse.json(
        { wallet, collection: collectionSlug, rows: [], reason: "acquisition_data_unavailable" },
        { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
      )
    }

    // Page through moment_acquisitions to bypass the 1000-row PostgREST cap.
    const PAGE = 1000
    const rows: Array<{ acquired_date: string }> = []
    for (let page = 0; page < 50; page++) {
      const { data, error } = await (supabaseAdmin as any)
        .from("moment_acquisitions")
        .select("acquired_date")
        .eq("wallet", wallet)
        .eq("collection_id", TOPSHOT_UUID)
        .not("acquired_date", "is", null)
        .range(page * PAGE, page * PAGE + PAGE - 1)
      if (error) throw new Error(error.message)
      const batch = (data ?? []) as Array<{ acquired_date: string }>
      rows.push(...batch)
      if (batch.length < PAGE) break
    }

    const counts: Record<Bucket, number> = { "0-30d": 0, "30-90d": 0, "90-180d": 0, "180-365d": 0, "365d+": 0 }
    const now = Date.now()
    for (const r of rows) {
      const t = new Date(r.acquired_date).getTime()
      if (!Number.isFinite(t)) continue
      const days = Math.max(0, Math.floor((now - t) / 86400000))
      counts[bucketFor(days)]++
    }

    const buckets = BUCKET_ORDER.map((b) => ({ bucket: b, count: counts[b] }))
    const total = rows.length

    console.log("[wallet-hold-time]", wallet, collectionSlug, total)

    return NextResponse.json(
      { wallet, collection: collectionSlug, total, buckets },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
    )
  } catch (err) {
    console.log("[wallet-hold-time] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 })
  }
}
