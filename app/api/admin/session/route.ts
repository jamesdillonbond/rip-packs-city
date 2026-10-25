// app/api/admin/session/route.ts
//
// POST { token } → { session, expires_at } — exchange the MASTER admin token for
// a short-lived signed session (security audit 2026-10-25, R134 step 2;
// lib/admin-session.ts). The admin pages store the session, never the master
// token, so a script that reads browser storage gets at most 12 hours of access.
//
// ⛔ Only the master token is accepted here — a session cannot mint a session,
// or a stolen one could be renewed forever. Body only (never ?token=), so the
// master token does not land in request logs. Rate limited by the proxy like any
// /api/ path.

import { NextRequest, NextResponse } from "next/server"
import { tokenMatches } from "@/lib/auth/bearer-secret"
import { mintAdminSession } from "@/lib/admin-session"

export const dynamic = "force-dynamic"

export async function POST(req: NextRequest) {
  let token = ""
  try {
    const body = (await req.json()) as { token?: unknown }
    token = typeof body?.token === "string" ? body.token.trim() : ""
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!tokenMatches(token, "RPC_ADMIN_TOKEN")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const minted = mintAdminSession(process.env.RPC_ADMIN_TOKEN)
  if (!minted) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json(
    { session: minted.session, expires_at: new Date(minted.expiresAt).toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
