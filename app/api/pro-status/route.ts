// app/api/pro-status/route.ts
// GET /api/pro-status?wallet=0x... — check if a wallet has Pro status

import { NextRequest, NextResponse } from "next/server"
import { getProStatus } from "@/lib/pro"

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet")
  if (!wallet) {
    return NextResponse.json({ isPro: false, plan: null, expiresAt: null })
  }
  try {
    const status = await getProStatus(wallet)
    return NextResponse.json(status)
  } catch {
    return NextResponse.json({ isPro: false, plan: null, expiresAt: null })
  }
}
