import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// wallet_moments_cache is keyed by the 3-col unique (wallet_address,
// collection_id, moment_id) since 2026-05-06 — there is NO plain
// (wallet_address, moment_id) index, so the old 2-col onConflict this route
// used raised 42P10 and wrote nothing. The POST is also a subset double-write
// of what /api/wallet-search already persists, so it now uses the
// change-detecting upsert_wmc_batch RPC (edition_key / serial / last_seen
// only — never clobbers the metadata / fmv that other writers own) and
// requires the caller to send the collection it belongs to.


// GET /api/wallet-cache?wallet=0x... — returns cached moments for fallback
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet")
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 })
    }

    // PostgREST caps any single read at 1,000 rows and silently CLAMPS an
    // explicit `.limit()` above it, so the old `.limit(10000)` returned only the
    // 1,000 most-recent rows for a large collector (wmc holds 5k–13k+ rows for a
    // whale) — a silent truncation that made the fallback show a partial
    // collection. Page with `.range()` over a STABLE sort (last_seen_at DESC with
    // moment_id as the tiebreak, so equal-timestamp rows never overlap or skip
    // across windows) until a short page signals the end, bounded by a hard
    // safety cap so the response can never grow without limit.
    const PAGE = 1000
    const MAX_ROWS = 50000
    const moments: unknown[] = []
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, fmv_usd, serial_number, player_name, set_name, tier, series_number, last_seen_at")
        .eq("wallet_address", wallet)
        .order("last_seen_at", { ascending: false })
        .order("moment_id", { ascending: true })
        .range(from, from + PAGE - 1)

      if (error) {
        console.warn("[wallet-cache] GET error:", error.message)
        // A partial cache is a better fallback than none; return what we have.
        // (A first-page error leaves `moments` empty ⇒ { ok:false, moments:[] },
        // preserving the prior degrade-on-error contract.)
        return NextResponse.json({ ok: moments.length > 0, moments })
      }

      const rows = (data ?? []) as unknown[]
      moments.push(...rows)
      if (rows.length < PAGE) break
    }

    return NextResponse.json({ ok: true, moments })
  } catch (err) {
    console.warn("[wallet-cache] GET error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, moments: [] })
  }
}

// POST is RETIRED (2026-10-09). It upserted client-supplied holdings — wallet,
// moment id, edition key, serial, all from the request body — into any
// wallet's cache through the service role, behind nothing but a session (any
// email can sign up). A caller could plant phantom moments in, or re-key the
// edition/serial of, someone else's portfolio. It was also redundant: the only
// caller echoed /api/wallet-search's rows, which that route already persists
// server-side, and it sent the raw search input (possibly a username) as the
// wallet key. Holdings are written by server-side walkers only. A stale client
// bundle that still POSTs gets a harmless 200 and nothing is written.
export async function POST() {
  return NextResponse.json({ ok: true, written: 0, skipped: "retired_server_side_writers_only" })
}
