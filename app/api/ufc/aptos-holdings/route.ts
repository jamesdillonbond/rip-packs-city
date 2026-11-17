// app/api/ufc/aptos-holdings/route.ts
//
// GET ?wallet=<Flow/Dapper address> → the UFC Strike moments this collector now holds ON
// APTOS, valued at each edition's current FMV.
//
// WHY (2026-11-16, Trevor's gate B in claude/ufc-reopen-on-aptos-plan-2026-11-16.md): UFC Strike
// moved from Flow to Aptos. A collector's Flow binder shows only what is still on Flow; what they
// migrated sits in an Aptos wallet the chain never names. `ufc_aptos_wallet_links` derives that
// wallet from matching Flow burns to Aptos mints, and `ufc_aptos_holdings` holds what each linked
// wallet owns (both filled by .github/workflows/ufc-aptos-sales-ingest.yml).
//
// ⛔ HONESTY CONTRACT — three states, never two:
//   - read failed            → apiErrorResponse (5xx). The client says it could not load, never $0.
//   - not linked / no rows   → { linked: false } and the client renders NO Aptos section. Users who
//                              migrated Aug–Oct 2025 are not linked until the Dune backfill (Dec 14);
//                              "none" would be a false claim about them.
//   - rows                   → { linked: true, moments, total_fmv, priced, unpriced }. A moment with
//                              no current FMV is counted as unpriced, never valued at 0.
// Link confidence and the Aptos address stay internal (plan: "confidence is internal only").
// The RPC is service_role-only, so this route holds the service key; it returns nothing that is
// not already public on two chains.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizeFlowAddress } from "@/lib/address"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const PAGE = 1000
const MAX_ROWS = 20000 // runaway guard; a wallet past it is reported as capped, not truncated silently

export interface UfcAptosMoment {
  token_data_id: string
  edition_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

export async function GET(req: NextRequest) {
  const wallet = normalizeFlowAddress(req.nextUrl.searchParams.get("wallet"))
  if (!wallet) {
    return NextResponse.json({ error: "wallet must be a Flow address (0x + 16 hex)" }, { status: 400 })
  }

  try {
    // 1. Holdings for every Aptos wallet linked to this Flow address. SETOF RPCs are capped at
    //    1,000 rows by PostgREST, so page it on a unique key.
    type Holding = { token_data_id: string; edition_id: string | null; serial_number: number | null }
    const holdings: Holding[] = []
    let capped = false
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await boundedRead(
        supabaseAdmin
          .rpc("get_ufc_aptos_holdings_for_flow", { p_flow_address: wallet })
          .select("token_data_id, edition_id, serial_number")
          .order("token_data_id")
          .range(from, from + PAGE - 1),
        "api/ufc/aptos-holdings/get_ufc_aptos_holdings_for_flow",
      )
      if (error) return apiErrorResponse(error, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
      const rows = (data ?? []) as Holding[]
      holdings.push(...rows)
      if (rows.length < PAGE) break
      if (holdings.length >= MAX_ROWS) { capped = true; break }
    }

    if (holdings.length === 0) {
      return NextResponse.json({ linked: false }, { headers: { "Cache-Control": "private, max-age=60" } })
    }

    // 2. Edition facts + current FMV for the editions held.
    const editionIds = [...new Set(holdings.map((h) => h.edition_id).filter((x): x is string => !!x))]
    const editions = new Map<string, { name: string | null; player_name: string | null; set_name: string | null; tier: string | null; circulation_count: number | null; thumbnail_url: string | null }>()
    const fmv = new Map<string, number | null>()
    for (let i = 0; i < editionIds.length; i += 200) {
      const slice = editionIds.slice(i, i + 200)
      const [ed, fv] = await Promise.all([
        boundedRead(
          supabaseAdmin
            .from("editions")
            .select("id, name, player_name, set_name, tier, circulation_count, thumbnail_url")
            .in("id", slice),
          "api/ufc/aptos-holdings/editions",
        ),
        boundedRead(
          supabaseAdmin.rpc("get_editions_latest_fmv_wide", { p_edition_ids: slice }),
          "api/ufc/aptos-holdings/get_editions_latest_fmv_wide",
        ),
      ])
      if (ed.error) return apiErrorResponse(ed.error, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
      if (fv.error) return apiErrorResponse(fv.error, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
      for (const e of (ed.data ?? []) as Array<{ id: string } & Record<string, unknown>>) {
        editions.set(e.id, {
          name: (e.name as string) ?? null,
          player_name: (e.player_name as string) ?? null,
          set_name: (e.set_name as string) ?? null,
          tier: (e.tier as string) ?? null,
          circulation_count: e.circulation_count == null ? null : Number(e.circulation_count),
          thumbnail_url: (e.thumbnail_url as string) ?? null,
        })
      }
      for (const f of (fv.data ?? []) as Array<{ edition_id: string; fmv_usd: number | string | null }>) {
        const v = f.fmv_usd == null ? null : Number(f.fmv_usd)
        fmv.set(f.edition_id, v != null && Number.isFinite(v) && v > 0 ? v : null)
      }
    }

    const moments: UfcAptosMoment[] = holdings.map((h) => {
      const e = h.edition_id ? editions.get(h.edition_id) : undefined
      return {
        token_data_id: h.token_data_id,
        edition_id: h.edition_id,
        name: e?.name ?? null,
        player_name: e?.player_name ?? null,
        set_name: e?.set_name ?? null,
        tier: e?.tier ?? null,
        serial_number: h.serial_number,
        circulation_count: e?.circulation_count ?? null,
        thumbnail_url: e?.thumbnail_url ?? null,
        fmv_usd: h.edition_id ? fmv.get(h.edition_id) ?? null : null,
      }
    })
    moments.sort((a, b) => (b.fmv_usd ?? -1) - (a.fmv_usd ?? -1))
    const priced = moments.filter((m) => m.fmv_usd != null)
    const total = priced.reduce((s, m) => s + (m.fmv_usd as number), 0)

    return NextResponse.json(
      {
        linked: true,
        count: moments.length,
        capped,
        priced: priced.length,
        unpriced: moments.length - priced.length,
        // null when nothing is priced — a total over zero priced moments is unknown, not $0
        total_fmv: priced.length ? Math.round(total * 100) / 100 : null,
        moments,
      },
      { headers: { "Cache-Control": "private, max-age=60" } },
    )
  } catch (err) {
    return apiErrorResponse(err, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
  }
}
