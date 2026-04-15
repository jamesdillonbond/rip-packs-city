// app/api/portfolio-export/route.ts
// CSV export of a wallet's full portfolio for a given collection.
// GET /api/portfolio-export?wallet=0x...&collection=slug

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const COLLECTION_UUID_MAP: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
  "laliga-golazos": "06248cc4-b85f-47cd-af67-1855d14acd75",
  "disney-pinnacle": "7dd9dd11-e8b6-45c4-ac99-71331f959714",
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  const collectionSlug = req.nextUrl.searchParams.get("collection") ?? "nba-top-shot"
  if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 })

  const collectionId = COLLECTION_UUID_MAP[collectionSlug]
  if (!collectionId) return NextResponse.json({ error: "Unknown collection" }, { status: 400 })

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("get_wallet_moments_with_fmv", {
      p_wallet: wallet,
      p_sort_by: "fmv_desc",
      p_limit: 99999,
      p_offset: 0,
      p_collection_id: collectionId,
    })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const moments: any[] = (data?.moments ?? []) as any[]

    const headers = [
      "Player", "Set", "Series", "Tier", "Serial", "Circulation",
      "FMV", "Low Ask", "Acquisition Method", "Buy Price",
      "Is Locked", "Acquired At",
    ]
    const lines = [headers.join(",")]
    for (const m of moments) {
      lines.push([
        csvCell(m.player_name),
        csvCell(m.set_name),
        csvCell(m.series_number),
        csvCell(m.tier),
        csvCell(m.serial_number),
        csvCell(m.circulation_count),
        csvCell(m.fmv_usd != null ? Number(m.fmv_usd).toFixed(2) : ""),
        csvCell(m.low_ask != null ? Number(m.low_ask).toFixed(2) : ""),
        csvCell(m.acquisition_method),
        csvCell(m.buy_price != null ? Number(m.buy_price).toFixed(2) : ""),
        csvCell(m.is_locked ? "true" : "false"),
        csvCell(m.acquired_at ?? ""),
      ].join(","))
    }
    const csv = lines.join("\n")
    const date = new Date().toISOString().slice(0, 10)
    const filename = `rpc-portfolio-${wallet}-${collectionSlug}-${date}.csv`

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
