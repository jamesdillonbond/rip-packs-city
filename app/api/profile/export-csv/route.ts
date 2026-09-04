import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireOwnedKey } from "@/lib/auth/owner-key-guard"

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

  // The export is a user's PRIVATE collection (saved wallets, buy prices,
  // acquisition method). ownerKey is client-controlled and the read below runs
  // on the service-role client (bypasses RLS), so prove the key belongs to the
  // authenticated caller first — else this is a read IDOR. Mirrors the guard
  // already applied to /api/wallet/save.
  const gate = await requireOwnedKey(ownerKey)
  if (gate instanceof Response) return gate

  try {
    const { data: wallets, error: walletsErr } = await boundedRead(supabase
      .from("saved_wallets")
      .select("wallet_addr")
      .eq("owner_key", ownerKey), "api/profile/export-csv/saved_wallets")
    if (walletsErr) {
      return apiErrorResponse(walletsErr, "api/profile/export-csv");
    }

    const addrs = (wallets ?? [])
      .map((w: any) => w.wallet_addr)
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
      const { data, error } = await boundedRead(supabase.rpc("export_wallet_csv", {
        p_wallet: addr,
      }), "api/profile/export-csv/export_wallet_csv")
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
