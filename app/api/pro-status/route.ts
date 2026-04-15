// app/api/pro-status/route.ts
// GET /api/pro-status?wallet=0x... — returns Pro status via is_pro_user RPC

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")?.trim().toLowerCase()
  if (!wallet) {
    return NextResponse.json({ is_pro: false, plan: null, expires_at: null, days_remaining: 0 })
  }

  try {
    const { data, error } = await (supabaseAdmin as any).rpc("is_pro_user", { p_wallet: wallet })
    if (error || !data) {
      return NextResponse.json({ is_pro: false, plan: null, expires_at: null, days_remaining: 0 })
    }
    return NextResponse.json({
      is_pro: !!data.is_pro,
      plan: data.plan ?? null,
      expires_at: data.expires_at ?? null,
      days_remaining: Number(data.days_remaining ?? 0),
    })
  } catch {
    return NextResponse.json({ is_pro: false, plan: null, expires_at: null, days_remaining: 0 })
  }
}
