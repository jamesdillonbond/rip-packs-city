// app/api/entity/panini-player-checklist/route.ts
//
// Panini PLAYER checklist (2026-11-23, Panini parity pass): every card the player page lists, owned vs missing for a
// PANINI USERNAME, and the cost to complete split by price source. Backs
// components/panini/PaniniPlayerChecklist.tsx on /panini-blockchain/player/<slug>.
//
//   GET /api/entity/panini-player-checklist?slug=<player slug>&username=<Panini username, optional>
//
// Why not /api/entity/team-checklist?entity=player: get_player_checklist reads wallet_moments_cache, which holds no
// Panini rows — a Panini owner is a USERNAME (lib/address.ts isPaniniUsername), never a wallet.
//
// Anon-visible GET (proxy.ts opens GET /api/entity/*); the RPC itself is service-role only.
// Three states: 404 = no Panini cards for that player · 400 = bad input · error = apiErrorResponse,
// never an empty checklist.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SLUG_RE = /^[a-z0-9-]{1,120}$/

export async function GET(req: Request) {
  const url = new URL(req.url)
  const slug = (url.searchParams.get("slug") ?? "").trim().toLowerCase()
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "missing or invalid player" }, { status: 400 })
  }
  const rawUsername = (url.searchParams.get("username") ?? "").trim()
  let username: string | null = null
  if (rawUsername) {
    username = normalizePaniniUsername(rawUsername)
    if (!username) {
      return NextResponse.json(
        { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -)." },
        { status: 400 },
      )
    }
  }

  const supa = supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  }
  const { data, error } = await boundedRead(
    supa.rpc("get_panini_player_checklist", { p_player_slug: slug, p_username: username }),
    "api/entity/panini-player-checklist",
  )
  if (error) return apiErrorResponse(error, "api/entity/panini-player-checklist")
  if (data == null) return NextResponse.json({ error: "no Panini cards for this player" }, { status: 404 })
  return NextResponse.json(data, {
    headers: { "Cache-Control": username ? "private, no-store" : "public, s-maxage=300, stale-while-revalidate=600" },
  })
}
