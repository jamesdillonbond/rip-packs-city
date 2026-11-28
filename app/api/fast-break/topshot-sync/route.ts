// app/api/fast-break/topshot-sync/route.ts
//
// "Sync from Top Shot": the signed-in collector's own Fast Break page, read in their browser
// (lib/fast-break/topshot-sync.ts → TOPSHOT_READER_SOURCE), lands here from RPC's Fast Break page.
// Writes, for THIS user and their pinned Top Shot wallet: the run (keyed by Top Shot's contest
// id), every night's objective and parsed targets, tonight's player list (= Pro eligibility) and
// Top Shot's own plays left. All in public.fast_break_ingest_topshot().
//
// The payload is the collector's own page as they see it — it can only describe their account,
// and the user id and wallet come from the session, never from the body.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { fetchPinnedWallet } from "@/lib/wallet/pinned-wallet"
import { normalizePlayers, topShotSyncSchema } from "@/lib/fast-break/topshot-sync"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-topshot-sync" }
const NBA_TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function fail(error: string, status: number, detail?: unknown) {
  return NextResponse.json(detail === undefined ? { error } : { error, detail }, { status, headers: ROUTE_HEADERS })
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return fail("malformed_json", 400)
  }
  const parsed = topShotSyncSchema.safeParse(raw)
  if (!parsed.success) return fail("invalid_payload", 400, parsed.error.format())

  const { wallet, ok: walletOk } = await fetchPinnedWallet(user.id, NBA_TOP_SHOT_UUID)
  if (!walletOk) return fail("wallet_lookup_failed", 500)

  const payload = {
    contest_id: parsed.data.contest_id,
    today: parsed.data.today,
    nights: parsed.data.nights,
    players: normalizePlayers(parsed.data.players),
    user_id: user.id,
    // Without a pinned wallet the run, nights and cards are still recorded; the uses
    // budget (which needs the wallet's Moments) is skipped.
    wallet: wallet ? wallet.toLowerCase() : null,
  }

  const { data, error } = await (supabase as any).rpc("fast_break_ingest_topshot", { p: payload })
  if (error) {
    console.error("[fast-break-topshot-sync] ingest:", error.message)
    return fail("ingest_failed", 500)
  }
  return NextResponse.json({ ok: true, result: data, walletPinned: !!wallet }, { headers: ROUTE_HEADERS })
}
