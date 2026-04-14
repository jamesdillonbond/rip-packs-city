import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"

export const maxDuration = 60

type Row = {
  player_name: string | null
  set_name: string | null
  series: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  fmv: number | string | null
  buy_price: number | string | null
  acquisition_method: string | null
  is_locked: boolean | null
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ""
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function GET(req: NextRequest) {
  const ownerKey = req.nextUrl.searchParams.get("ownerKey")
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 })
  }

  try {
    const { data: wallets, error: walletsErr } = await supabase
      .from("saved_wallets")
      .select("wallet_address")
      .eq("owner_key", ownerKey)
    if (walletsErr) {
      return NextResponse.json({ error: walletsErr.message }, { status: 500 })
    }

    const addrs = (wallets ?? [])
      .map((w: any) => w.wallet_address)
      .filter((a: any): a is string => typeof a === "string" && a.length > 0)

    const header = [
      "Wallet",
      "Player",
      "Set",
      "Series",
      "Tier",
      "Serial",
      "Mint Size",
      "FMV",
      "Buy Price",
      "Acquisition Method",
      "Locked",
    ]
    const lines: string[] = [header.join(",")]

    for (const addr of addrs) {
      const { data, error } = await supabase.rpc("export_wallet_csv", {
        p_wallet: addr,
      })
      if (error) {
        console.error("[export-csv rpc]", addr, error.message)
        continue
      }
      const rows: Row[] = Array.isArray(data) ? (data as Row[]) : []
      for (const r of rows) {
        lines.push(
          [
            csvEscape(addr),
            csvEscape(r.player_name),
            csvEscape(r.set_name),
            csvEscape(r.series),
            csvEscape(r.tier),
            csvEscape(r.serial_number),
            csvEscape(r.circulation_count),
            csvEscape(r.fmv),
            csvEscape(r.buy_price),
            csvEscape(r.acquisition_method),
            csvEscape(r.is_locked ? "true" : "false"),
          ].join(",")
        )
      }
    }

    const body = lines.join("\n") + "\n"
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="rpc-collection-export.csv"',
        "Cache-Control": "no-store",
      },
    })
  } catch (err: any) {
    console.error("[export-csv GET]", err?.message)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
