import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
// Use the centralised slug↔DB-slug bridge — a hand-rolled local copy drifted:
// it mapped "ufc" → "ufc" but the collections row is "ufc_strike", so a UFC
// wallet silently resolved to the Top Shot collection_id via the fallback below.
import { SLUG_TO_DB_SLUG } from "@/lib/collections"
import { boundedRead } from "@/lib/api/bounded-read"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

async function resolveCollectionId(input?: string | null): Promise<string> {
  if (!input) return TOPSHOT_COLLECTION_ID
  // Direct UUID pass-through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input
  }
  const dbSlug = SLUG_TO_DB_SLUG[input] ?? input
  // ⚠ DELIBERATELY LEFT UNBOUNDED, 2026-09-04, and the reason is a defect rather
  // than an exemption. Both exits here fall back to `TOPSHOT_COLLECTION_ID`, so a
  // failed lookup for (say) laliga-golazos does not degrade — it silently answers
  // with TOP SHOT's acquisition stats under the caller's collection label. That is
  // a false claim about someone's own wallet, the worst sub-class in the canon.
  //
  // Bounding this read would make that fallback MORE reachable (a slow lookup
  // would start taking it too), so the bound is not the fix and adding one here
  // would quietly widen the defect while looking like a hardening commit. The fix
  // is to resolve the collection honestly or fail — a behaviour change with a
  // caller contract attached, filed rather than slipped into a bounding pass.
  try {
    const { data } = await (supabaseAdmin as any)
      .from("collections")
      .select("id")
      .eq("slug", dbSlug)
      .single()
    return data?.id ?? TOPSHOT_COLLECTION_ID
  } catch {
    return TOPSHOT_COLLECTION_ID
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  const collectionParam = req.nextUrl.searchParams.get("collection")
  if (!wallet) {
    return NextResponse.json({ error: "wallet parameter required" }, { status: 400 })
  }

  try {
    const collectionId = await resolveCollectionId(collectionParam)
    const walletAddr = wallet.startsWith("0x") ? wallet : "0x" + wallet
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).rpc("get_acquisition_stats", { p_wallet: walletAddr, p_collection_id: collectionId }),
      "api/acquisition-stats/get_acquisition_stats",
    )

    if (error) {
      console.log("[acquisition-stats] RPC error:", error.message)
      return NextResponse.json({ error: "Database query failed" }, { status: 500 })
    }

    const result = Array.isArray(data) ? data[0] : data
    return NextResponse.json(result ?? { breakdown: [], total_moments: 0, total_spent: 0, locked_count: 0 })
  } catch (err) {
    console.log("[acquisition-stats] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
