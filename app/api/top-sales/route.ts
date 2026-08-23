import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

// Multi-collection "Recent Top Sales" feed. Uses the get_top_sales() RPC
// (7 day lookback) for non-Pinnacle collections, and queries pinnacle_sales
// directly for Disney Pinnacle since that collection lives in its own table.
//
// ── deep-audit R33 ─────────────────────────────────────────────────────────
// The Pinnacle branch had FOUR defects and the non-Pinnacle branch shared two:
//
//   1. `?? "Unknown"` on the name — a failed join rendered a moment literally
//      called "Unknown", in the same type as a real one.
//   2. `Number(serial_number ?? 0)` — a NULL serial rendered as **#0**, which
//      is not a serial that can exist. Measured 2026-08-23: **5 of the top 5
//      Pinnacle sales by price in 7d carry a NULL serial_number**, so every row
//      this route emitted for Pinnacle said #0.
//   3. `circulationCount: 0` was HARDCODED — a fabricated supply on every
//      Pinnacle row, never read from anything.
//   4. 🚨 A failed read returned `[]` — so a database error rendered as
//      "no top sales", at **HTTP 200**, and was then cached `s-maxage=300`,
//      serving that false claim for five minutes. The non-Pinnacle branch
//      returned 500 for the same failure; one route, two answers.
//
// ⚠ R33's other half has since RESOLVED and is not re-asserted here: it
// recorded "4 of 5 have NULL edition_id"; measured today that is **0 of 5**.
//
// Every unknown is now `null`, never a stand-in value. A consumer that wants
// to print something for a missing serial can choose its own em dash; this
// route's job is to say it does not know.
//
// ⚠ The route has ZERO callers in the repo (grepped over app/ components/ lib/
// workers/ scripts/ .github/ and vercel.json for the literal path). It is fixed
// rather than deleted because an external or template-literal caller cannot be
// ruled out by that grep, and a wrong answer is worse than a removed one.

type TopSaleRow = {
  playerName: string | null
  setName: string | null
  tier: string | null
  serialNumber: number | null
  circulationCount: number | null
  price: number | null
}

type RpcTopSaleRow = {
  player_name?: string | null
  set_name?: string | null
  tier?: string | null
  serial_number?: number | string | null
  circulation_count?: number | string | null
  price_usd?: number | string | null
}

/** `null` when the value is absent or unparseable — never a stand-in number. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/**
 * ⚠ Returns a DISCRIMINATED result, not a bare array. The previous signature
 * could not express "the read failed", so the caller could not tell it apart
 * from "there were no sales" — and chose the reassuring one.
 */
async function pinnacleTopSales(
  limit: number,
  since: string
): Promise<{ ok: true; rows: TopSaleRow[] } | { ok: false; message: string }> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_sales")
    .select(
      "sale_price_usd, serial_number, edition_id, sold_at, " +
        "pinnacle_editions(character_name, set_name, variant_type)"
    )
    .gte("sold_at", since)
    .order("sale_price_usd", { ascending: false })
    .limit(limit)
  if (error) return { ok: false, message: error.message }

  return {
    ok: true,
    rows: ((data ?? []) as any[]).map((r) => ({
      playerName: str(r.pinnacle_editions?.character_name),
      setName: str(r.pinnacle_editions?.set_name),
      tier: str(r.pinnacle_editions?.variant_type)?.toUpperCase() ?? null,
      serialNumber: num(r.serial_number),
      // Pinnacle supply is not carried on pinnacle_sales and is not joined
      // here. It was previously hardcoded to 0; null is the honest value.
      circulationCount: null,
      price: num(r.sale_price_usd),
    })),
  }
}

/** A failure must never be cached — five minutes of a false "no sales". */
function failed(where: string, message: string) {
  console.error(`[top-sales] ${where}: ${message}`)
  return NextResponse.json(
    { error: "Top sales are unavailable right now.", sales: null },
    { status: 500, headers: { "Cache-Control": "no-store" } }
  )
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("collection")?.trim() || "nba-top-shot"
  const limit = Math.min(
    Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "5", 10) || 5, 1),
    25
  )

  const collectionId = getCollectionUuid(slug)
  // An unknown slug is a genuine empty, not a failure — the caller asked for a
  // collection that does not exist.
  if (!collectionId) return NextResponse.json({ sales: [] })

  const since = new Date(Date.now() - 7 * 86400000).toISOString()

  const ok = (sales: TopSaleRow[]) => {
    const res = NextResponse.json({ sales })
    res.headers.set("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600")
    return res
  }

  try {
    if (slug === "disney-pinnacle") {
      const result = await pinnacleTopSales(limit, since)
      if (!result.ok) return failed("pinnacle read", result.message)
      return ok(result.rows)
    }

    const { data, error } = await (supabaseAdmin as any).rpc("get_top_sales", {
      p_collection_id: collectionId,
      p_since: since,
      p_limit: limit,
    })
    if (error) return failed("get_top_sales rpc", error.message)

    const rows = (data ?? []) as RpcTopSaleRow[]
    return ok(
      rows.map((r) => ({
        playerName: str(r.player_name),
        setName: str(r.set_name),
        tier: str(r.tier)?.toUpperCase() ?? null,
        serialNumber: num(r.serial_number),
        circulationCount: num(r.circulation_count),
        price: num(r.price_usd),
      }))
    )
  } catch (err) {
    return failed("exception", err instanceof Error ? err.message : String(err))
  }
}
