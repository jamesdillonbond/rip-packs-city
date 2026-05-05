// app/api/early-access/submit/route.ts
//
// Soft-launch sign-up endpoint. Accepts the /early-access form payload, runs
// minimal validation, hashes the request IP, and forwards to the
// submit_allow_list_request RPC via the service-role Supabase client.
//
// Returns the RPC's jsonb shape verbatim — { ok, duplicate, status } — so the
// page can render the right copy. Never exposes the internal table.

import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { supabaseAdmin } from "@/lib/supabase"

const WALLET_RE = /^0x[a-fA-F0-9]{16}$/
const ALLOWED_COLLECTIONS = new Set([
  "nba_top_shot",
  "nfl_all_day",
  "laliga_golazos",
  "disney_pinnacle",
  "ufc_strike",
])

function hashIp(ip: string | null): string | null {
  if (!ip) return null
  const trimmed = ip.trim()
  if (!trimmed) return null
  return createHash("sha256").update(trimmed).digest("hex")
}

function getClientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]?.trim() || null
  const real = req.headers.get("x-real-ip")
  if (real) return real.trim() || null
  return null
}

export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const data = (body ?? {}) as {
    email?: unknown
    wallet?: unknown
    username?: unknown
    collections?: unknown
  }

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : ""
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "Email is required." }, { status: 400 })
  }

  const walletRaw = typeof data.wallet === "string" ? data.wallet.trim() : ""
  const wallet = walletRaw.length > 0 ? walletRaw : null
  if (wallet && !WALLET_RE.test(wallet)) {
    return NextResponse.json(
      { ok: false, error: "Wallet must be 0x followed by exactly 16 hex characters." },
      { status: 400 }
    )
  }

  const usernameRaw = typeof data.username === "string" ? data.username.trim() : ""
  const username = usernameRaw.length > 0 ? usernameRaw : null

  if (!wallet && !username) {
    return NextResponse.json(
      { ok: false, error: "Provide either a Flow wallet address or a username." },
      { status: 400 }
    )
  }

  const collectionsInput = Array.isArray(data.collections) ? data.collections : []
  const collections = Array.from(
    new Set(
      collectionsInput
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter((c) => ALLOWED_COLLECTIONS.has(c))
    )
  )

  const userAgent = req.headers.get("user-agent") ?? null
  const ipHash = hashIp(getClientIp(req))

  const { data: rpc, error } = await supabaseAdmin.rpc("submit_allow_list_request", {
    p_email: email,
    p_wallet_addr: wallet,
    p_username: username,
    p_collections: collections,
    p_source: "early_access_form",
    p_user_agent: userAgent,
    p_ip_hash: ipHash,
  })

  if (error) {
    console.error("[early-access/submit] RPC error", error)
    return NextResponse.json(
      { ok: false, error: "We couldn't save your request. Please try again." },
      { status: 500 }
    )
  }

  // RPC contract: { ok, duplicate, status }
  const result = (rpc ?? {}) as { ok?: boolean; duplicate?: boolean; status?: string }
  if (result.ok === false) {
    return NextResponse.json(
      { ok: false, error: "Request rejected.", ...result },
      { status: 400 }
    )
  }

  return NextResponse.json({
    ok: true,
    duplicate: Boolean(result.duplicate),
    status: result.status ?? "pending",
  })
}
