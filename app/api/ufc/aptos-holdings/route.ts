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
export const maxDuration = 60

const PAGE = 1000
const MAX_ROWS = 20000 // runaway guard; a wallet past it is reported as capped, not truncated silently

export interface UfcAptosMoment {
  token_data_id: string
  edition_id: string | null
  /** editions.external_id — the binder links an Aptos row to its edition page (2026-11-26). */
  edition_key: string | null
  /** The Moment's Aptos collection, for the Rarible collection link; null when unmapped or the read failed. */
  aptos_collection_id: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

// ── Aptos account mode (2026-11-26, Trevor: "aggregate across the multiple chains/wallets") ──────────
// GET ?aptos=<64-hex Aptos account> reads that account LIVE from the Aptos indexer, for collectors who
// hold UFC on an Aptos wallet RPC cannot link to a Flow address (Aptos-native, or not yet matched).
// Only UFC Strike tokens count (collections mapped in ufc_aptos_collections). A failed indexer page is a
// 5xx, never a shorter list; a wallet past MAX_APTOS_PAGES is reported `capped`.
const APTOS_INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const MAX_APTOS_PAGES = 30
const APTOS_Q = `query($o:String!,$off:Int){current_token_ownerships_v2(where:{owner_address:{_eq:$o},amount:{_gt:"0"}},order_by:{token_data_id:asc},limit:100,offset:$off){token_data_id current_token_data{collection_id token_properties}}}`

function normalizeAptosAccount(v: string | null): string | null {
  const s = (v ?? "").trim().toLowerCase()
  return /^0x[0-9a-f]{64}$/.test(s) ? s : null
}

type Holding = { token_data_id: string; edition_id: string | null; serial_number: number | null }

async function liveAptosHoldings(owner: string): Promise<{ holdings: Holding[]; capped: boolean }> {
  const editionOf = new Map<string, string | null>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await boundedRead(
      supabaseAdmin.from("ufc_aptos_collections").select("aptos_collection_id, edition_id").order("aptos_collection_id").range(from, from + PAGE - 1),
      "api/ufc/aptos-holdings/ufc_aptos_collections-map",
    )
    if (error) throw error
    const rows = (data ?? []) as Array<{ aptos_collection_id: string; edition_id: string | null }>
    for (const r of rows) editionOf.set(r.aptos_collection_id, r.edition_id)
    if (rows.length < PAGE) break
  }
  const key = process.env.APTOS_API_KEY
  const holdings: Holding[] = []
  for (let page = 0; ; page++) {
    if (page >= MAX_APTOS_PAGES) return { holdings, capped: true }
    const res = await fetch(APTOS_INDEXER, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ query: APTOS_Q, variables: { o: owner, off: page * 100 } }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    })
    if (!res.ok) throw new Error(`aptos indexer ${res.status}`)
    const j = (await res.json()) as { data?: { current_token_ownerships_v2?: Array<{ token_data_id: string; current_token_data?: { collection_id?: string; token_properties?: Record<string, unknown> } }> }; errors?: unknown }
    if (j.errors || !j.data?.current_token_ownerships_v2) throw new Error("aptos indexer error")
    const rows = j.data.current_token_ownerships_v2
    for (const t of rows) {
      const coll = t.current_token_data?.collection_id
      if (!coll || !editionOf.has(coll)) continue
      const serial = Number.parseInt(String(t.current_token_data?.token_properties?.["Serial Number"] ?? ""), 10)
      holdings.push({ token_data_id: t.token_data_id, edition_id: editionOf.get(coll) ?? null, serial_number: Number.isFinite(serial) ? serial : null })
    }
    if (rows.length < 100) return { holdings, capped: false }
  }
}

export async function GET(req: NextRequest) {
  const aptosParam = req.nextUrl.searchParams.get("aptos")
  const aptosOwner = aptosParam != null ? normalizeAptosAccount(aptosParam) : null
  if (aptosParam != null && !aptosOwner) {
    return NextResponse.json({ error: "aptos must be an Aptos account (0x + 64 hex)" }, { status: 400 })
  }
  const wallet = aptosOwner ? null : normalizeFlowAddress(req.nextUrl.searchParams.get("wallet"))
  if (!aptosOwner && !wallet) {
    return NextResponse.json({ error: "wallet must be a Flow address (0x + 16 hex)" }, { status: 400 })
  }

  try {
    // 1. Holdings: an Aptos account read live (aptos mode), or every Aptos wallet linked to this Flow
    //    address (SETOF RPCs are capped at 1,000 rows by PostgREST, so page it on a unique key).
    const holdings: Holding[] = []
    let capped = false
    if (aptosOwner) {
      const live = await liveAptosHoldings(aptosOwner)
      holdings.push(...live.holdings)
      capped = live.capped
    }
    for (let from = 0; wallet; from += PAGE) {
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
    const editions = new Map<string, { external_id: string | null; name: string | null; player_name: string | null; set_name: string | null; tier: string | null; circulation_count: number | null; thumbnail_url: string | null }>()
    const fmv = new Map<string, number | null>()
    const aptosColl = new Map<string, string>()
    for (let i = 0; i < editionIds.length; i += 200) {
      const slice = editionIds.slice(i, i + 200)
      const [ed, fv, ac] = await Promise.all([
        boundedRead(
          supabaseAdmin
            .from("editions")
            .select("id, external_id, name, player_name, set_name, tier, circulation_count, thumbnail_url")
            .in("id", slice),
          "api/ufc/aptos-holdings/editions",
        ),
        boundedRead(
          supabaseAdmin.rpc("get_editions_latest_fmv_wide", { p_edition_ids: slice }),
          "api/ufc/aptos-holdings/get_editions_latest_fmv_wide",
        ),
        // Link only: a failed read drops the Rarible link, never a Moment or its value.
        boundedRead(
          supabaseAdmin
            .from("ufc_aptos_collections")
            .select("edition_id, aptos_collection_id")
            .in("edition_id", slice)
            .order("aptos_collection_id", { ascending: true }),
          "api/ufc/aptos-holdings/ufc_aptos_collections",
        ),
      ])
      if (!ac.error) {
        for (const c of (ac.data ?? []) as Array<{ edition_id: string; aptos_collection_id: string | null }>) {
          if (c.aptos_collection_id && !aptosColl.has(c.edition_id)) aptosColl.set(c.edition_id, c.aptos_collection_id)
        }
      }
      if (ed.error) return apiErrorResponse(ed.error, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
      if (fv.error) return apiErrorResponse(fv.error, "api/ufc/aptos-holdings", "Aptos holdings aren't available right now.")
      for (const e of (ed.data ?? []) as Array<{ id: string } & Record<string, unknown>>) {
        editions.set(e.id, {
          external_id: e.external_id == null ? null : String(e.external_id),
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
        edition_key: e?.external_id ?? null,
        aptos_collection_id: h.edition_id ? aptosColl.get(h.edition_id) ?? null : null,
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
