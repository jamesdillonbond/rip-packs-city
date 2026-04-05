import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/*
  Migration SQL (run manually or via Supabase apply_migration):

  CREATE TABLE IF NOT EXISTS wallet_moments_cache (
    wallet_address text NOT NULL,
    moment_id text NOT NULL,
    edition_key text,
    fmv_usd numeric,
    serial_number integer,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (wallet_address, moment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_moments_cache_wallet ON wallet_moments_cache (wallet_address);
*/

// GET /api/wallet-cache?wallet=0x... — returns cached moments for fallback
export async function GET(req: NextRequest) {
  try {
    const wallet = req.nextUrl.searchParams.get("wallet")
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "wallet required" }, { status: 400 })
    }

    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, fmv_usd, serial_number, player_name, set_name, tier, series_number, last_seen_at")
      .eq("wallet_address", wallet)
      .order("last_seen_at", { ascending: false })
      .limit(10000)

    if (error) {
      console.warn("[wallet-cache] GET error:", error.message)
      return NextResponse.json({ ok: false, moments: [] })
    }

    return NextResponse.json({ ok: true, moments: data ?? [] })
  } catch (err) {
    console.warn("[wallet-cache] GET error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, moments: [] })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const wallet = body.wallet as string | undefined
    const moments = body.moments as Array<{
      momentId?: string
      editionKey?: string | null
      fmv?: number | null
      serial?: number | null
      playerName?: string | null
      setName?: string | null
      tier?: string | null
      series?: string | number | null
    }> | undefined

    if (!wallet || !Array.isArray(moments) || !moments.length) {
      return NextResponse.json({ ok: true, written: 0 })
    }

    const rows = moments
      .filter(function(m) { return m.momentId })
      .map(function(m) {
        const seriesNum = m.series != null ? parseInt(String(m.series), 10) : null
        return {
          wallet_address: wallet,
          moment_id: m.momentId!,
          edition_key: m.editionKey ?? null,
          fmv_usd: m.fmv ?? null,
          serial_number: m.serial ?? null,
          player_name: m.playerName ?? null,
          set_name: m.setName ?? null,
          tier: m.tier ?? null,
          series_number: seriesNum != null && Number.isFinite(seriesNum) ? seriesNum : null,
          last_seen_at: new Date().toISOString(),
        }
      })

    if (!rows.length) {
      return NextResponse.json({ ok: true, written: 0 })
    }

    const CHUNK = 200
    let written = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { data } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,moment_id" })
        .select("moment_id")
      written += data?.length ?? chunk.length
    }

    return NextResponse.json({ ok: true, written })
  } catch (err) {
    console.warn("[wallet-cache] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: true, written: 0 })
  }
}
