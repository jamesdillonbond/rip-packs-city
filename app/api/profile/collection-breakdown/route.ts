import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

// Collection color palette (keyed by slug from collections table)
const COLLECTION_COLOR: Record<string, string> = {
  "nba-top-shot": "#E03A2F",
  "nfl-all-day": "#10B981",
  "laliga-golazos": "#FBBF24",
  "la-liga-golazos": "#FBBF24",
  "disney-pinnacle": "#8B5CF6",
}
const DEFAULT_COLOR = "#6B7280"

type Row = {
  collection_id: string | null
  collection_name: string | null
  moment_count: number
  total_fmv: number | string | null
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 })
  }

  try {
    const { data: wallets, error: walletsErr } = await supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("owner_key", ownerKey)
    if (walletsErr) {
      return NextResponse.json({ error: walletsErr.message }, { status: 500 })
    }

    const addrs = (wallets ?? [])
      .map((w: any) => w.wallet_addr)
      .filter((a: any): a is string => typeof a === "string" && a.length > 0)

    const merged = new Map<
      string,
      { collection_id: string; collection_name: string; moment_count: number; total_fmv: number }
    >()

    for (const addr of addrs) {
      const { data, error } = await supabase.rpc("get_collection_breakdown", {
        p_wallet: addr,
      })
      if (error) {
        console.error("[collection-breakdown rpc]", addr, error.message)
        continue
      }
      const rows: Row[] = Array.isArray(data) ? (data as Row[]) : []
      for (const r of rows) {
        const id = r.collection_id ?? "unknown"
        const existing = merged.get(id)
        const fmv = Number(r.total_fmv ?? 0)
        if (existing) {
          existing.moment_count += Number(r.moment_count ?? 0)
          existing.total_fmv += Number.isFinite(fmv) ? fmv : 0
        } else {
          merged.set(id, {
            collection_id: id,
            collection_name: r.collection_name ?? "Unknown",
            moment_count: Number(r.moment_count ?? 0),
            total_fmv: Number.isFinite(fmv) ? fmv : 0,
          })
        }
      }
    }

    // Look up slugs so we can color-code by slug.
    const ids = Array.from(merged.keys()).filter((id) => id !== "unknown")
    const slugMap = new Map<string, string>()
    if (ids.length > 0) {
      const { data: cols } = await supabase
        .from("collections")
        .select("id, slug")
        .in("id", ids)
      for (const c of cols ?? []) {
        if (c.id && c.slug) slugMap.set(c.id, c.slug)
      }
    }

    const collections = Array.from(merged.values())
      .map((c) => ({
        ...c,
        color: COLLECTION_COLOR[slugMap.get(c.collection_id) ?? ""] ?? DEFAULT_COLOR,
      }))
      .sort((a, b) => b.total_fmv - a.total_fmv || b.moment_count - a.moment_count)

    return NextResponse.json({ collections })
  } catch (err: any) {
    console.error("[collection-breakdown GET]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
