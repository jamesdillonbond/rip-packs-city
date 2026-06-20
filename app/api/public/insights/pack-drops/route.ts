// app/api/public/insights/pack-drops/route.ts
//
// PUBLIC INSIGHTS — Pack Drops. Scores Vaultopolis curated "re-pack" drops of
// real Top Shot moments against RPC FMV: "is this drop worth it?" — intelligence
// no native surface offers (and the wedge that draws Vaultopolis buyers to RPC).
//
// Read-only, zero custody: discovers drops from Vaultopolis's open API, rolls
// each drop's moments to distinct (player, set, series), prices them via the
// SECDEF get_pack_drop_pricing RPC, and computes RPC pool / pack EV / value
// concentration / a verdict vs the FLOW listing price. No inventory tables, no
// contract — that's Shape B (separate, gated).
//
// Lives under /api/public/* so the proxy.ts allowlist lets anon through with no
// auth.
//
// Response: { meta: { fetched_at, source, total_drops, elapsed_ms }, drops: [...] }
//
// CACHE: 15-min s-maxage (Vaultopolis composition/odds are fixed at publication;
// sale-state moves slowly; this bounds load + a viral OG-share spike).

import { NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { fetchScoredDrops } from "@/lib/pack-drops-board"

export async function GET() {
  const startedAt = Date.now()

  let drops
  try {
    drops = await fetchScoredDrops(supabase)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[public/insights/pack-drops]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  const elapsedMs = Date.now() - startedAt
  console.log(`[public/insights/pack-drops] drops=${drops.length} elapsedMs=${elapsedMs}`)

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "vaultopolis_public_api + rpc_fmv",
      total_drops: drops.length,
      elapsed_ms: elapsedMs,
    },
    drops,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
