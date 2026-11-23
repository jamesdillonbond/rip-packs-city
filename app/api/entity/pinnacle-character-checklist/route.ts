// app/api/entity/pinnacle-character-checklist/route.ts
//
// Disney Pinnacle CHARACTER checklist (2026-11-23, Pinnacle roadmap pass): every pin of one character,
// owned vs missing for a Flow wallet, and the cost to complete split by price source. Backs
// components/pinnacle/PinnacleCharacterChecklist.tsx on /disney-pinnacle/character/<slug>.
//
//   GET /api/entity/pinnacle-character-checklist?character=<name>&wallet=<0x… optional>
//
// Why not /api/entity/team-checklist?entity=player: get_player_checklist reads the shared `editions`
// table and returns [] for Pinnacle by design — a pin is a pinnacle_catalog row (render_id), and a
// character is the `characters` trait (CLAUDE.md "Disney Pinnacle grain").
//
// Anon-visible GET (proxy.ts opens GET /api/entity/*); the RPC itself is service-role only.
// Three states: 404 = no pins for that character · 400 = bad input · error = apiErrorResponse,
// never an empty checklist.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { parseChecklistWallet } from "@/lib/entity/checklist-wallet"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const character = (url.searchParams.get("character") ?? "").trim()
  if (!character || character.length > 120) {
    return NextResponse.json({ error: "missing or invalid character" }, { status: 400 })
  }
  // Disney Pinnacle is a Flow collection: a 0x Dapper address, lowercased (lib/entity/checklist-wallet.ts).
  const rawWallet = url.searchParams.get("wallet")
  const parsed = parseChecklistWallet(rawWallet, "flow")
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (rawWallet && rawWallet.trim() && parsed.wallet === null) {
    return NextResponse.json({ error: "Enter a Dapper wallet address (0x followed by 16 characters)." }, { status: 400 })
  }

  const supa = supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  }
  const { data, error } = await boundedRead(
    supa.rpc("get_pinnacle_character_checklist", { p_character: character, p_wallet: parsed.wallet }),
    "api/entity/pinnacle-character-checklist",
  )
  if (error) return apiErrorResponse(error, "api/entity/pinnacle-character-checklist")
  if (data == null) return NextResponse.json({ error: "no pins for this character" }, { status: 404 })
  return NextResponse.json(data, {
    headers: { "Cache-Control": parsed.wallet ? "private, no-store" : "public, s-maxage=300, stale-while-revalidate=600" },
  })
}
