import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
// Use the centralised slug↔DB-slug bridge — a hand-rolled local copy drifted:
// it mapped "ufc" → "ufc" but the collections row is "ufc_strike", so a UFC
// wallet silently resolved to the Top Shot collection_id via the fallback below.
import { SLUG_TO_DB_SLUG } from "@/lib/collections"
import { boundedRead } from "@/lib/api/bounded-read"
import { detectAddressChain } from "@/lib/address"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

type Resolved = { ok: true; id: string } | { ok: false; status: 404 | 503; error: string }

// An ABSENT collection defaults to Top Shot (the route's original contract). A
// PRESENT one resolves or the request fails — never Top Shot's stats under the
// caller's label (2026-09-26; until then an unknown slug OR a failed lookup
// answered with Top Shot, a false claim about someone's own wallet).
async function resolveCollectionId(input?: string | null): Promise<Resolved> {
  if (!input) return { ok: true, id: TOPSHOT_COLLECTION_ID }
  // Direct UUID pass-through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return { ok: true, id: input }
  }
  const dbSlug = SLUG_TO_DB_SLUG[input] ?? input
  try {
    const { data, error } = await boundedRead(
      (supabaseAdmin as any).from("collections").select("id").eq("slug", dbSlug).maybeSingle(),
      "api/acquisition-stats/collections",
    )
    if (error) return { ok: false, status: 503, error: "Collection lookup unavailable" }
    if (!data?.id) return { ok: false, status: 404, error: `unknown collection '${input}'` }
    return { ok: true, id: data.id }
  } catch {
    return { ok: false, status: 503, error: "Collection lookup unavailable" }
  }
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  const collectionParam = req.nextUrl.searchParams.get("collection")
  if (!wallet) {
    return NextResponse.json({ error: "wallet parameter required" }, { status: 400 })
  }

  try {
    const resolved = await resolveCollectionId(collectionParam)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }
    const collectionId = resolved.id
    // A Solana (Candy) key is base58 and case-sensitive: prefixing "0x" destroys it.
    // The Flow/EVM path is unchanged.
    const walletAddr =
      detectAddressChain(wallet) === "solana" ? wallet.trim() : wallet.startsWith("0x") ? wallet : "0x" + wallet
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
