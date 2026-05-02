// GET /api/analytics/wallets/resolve-usernames?addrs=0xabc,0xdef
//
// Thin wrapper over analytics_resolve_usernames(p_addrs). Returns a flat
// { addr → username } map for any addresses found in wallet_usernames.
// Addresses with no entry are simply omitted from the response.
//
// Limit: ~100 addresses per call to keep query strings reasonable.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const revalidate = 3600

const MAX_ADDRS = 100
const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const raw = url.searchParams.get("addrs") ?? ""
    const addrs = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => FLOW_ADDR_RE.test(s))

    if (addrs.length === 0) {
      return NextResponse.json(
        { usernames: {} },
        {
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=7200",
          },
        }
      )
    }

    const unique = Array.from(new Set(addrs)).slice(0, MAX_ADDRS)

    const { data, error } = await rpcWithRetry<Record<string, string>>(
      supabaseAdmin,
      "analytics_resolve_usernames",
      { p_addrs: unique }
    )

    if (error) {
      console.log("[wallets/resolve-usernames] rpc_error", error.message)
      return NextResponse.json({ error: "resolve_usernames_failed" }, { status: 500 })
    }

    const usernames = (data ?? {}) as Record<string, string>

    console.log(
      `[wallets/resolve-usernames] ok elapsed=${Date.now() - t0}ms in=${unique.length} matched=${Object.keys(usernames).length}`
    )

    return NextResponse.json(
      { usernames },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=7200",
        },
      }
    )
  } catch (e: any) {
    console.log("[wallets/resolve-usernames] error", e?.message || e)
    return NextResponse.json({ error: "resolve_usernames_failed" }, { status: 500 })
  }
}
