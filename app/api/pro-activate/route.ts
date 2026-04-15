// app/api/pro-activate/route.ts
// Manual Pro activation fallback for when the scanner can't auto-attribute a sender.
// POST { wallet, momentNftId, fmv?, durationDays?, plan? }
// Auth: Bearer INGEST_SECRET_TOKEN

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const wallet = String(body.wallet ?? "").trim().toLowerCase()
  const momentNftId = String(body.momentNftId ?? "").trim()
  if (!wallet || !momentNftId) {
    return NextResponse.json({ error: "wallet and momentNftId required" }, { status: 400 })
  }

  const fmv = body.fmv != null ? Number(body.fmv) : null
  const durationDays = body.durationDays != null ? Number(body.durationDays) : 30

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("activate_pro_from_payment", {
      p_sender_wallet: wallet,
      p_moment_nft_id: momentNftId,
      p_fmv: fmv,
      p_duration_days: durationDays,
    })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, result: data })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
