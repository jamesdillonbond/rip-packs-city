// app/api/wallet-cost-basis/route.ts
//
// GET /api/wallet-cost-basis?wallet=0x...|username&collection=<slug>
// Computes per-moment P&L for a wallet's TopShot acquisitions where buy_price is known.
// Aggregates a summary block + top gainers/losers.
//
// Non-TopShot collections return reason='cost_basis_unavailable' (200).
// Zero-tracked TopShot wallets return reason='no_tracked_acquisitions'.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

type UsernameProfileResponse = {
  getUserProfileByUsername?: { publicInfo?: { flowAddress?: string | null } | null } | null
}

async function resolveWallet(input: string): Promise<string> {
  const t = input.trim()
  if (t.startsWith("0x") && t.length === 18) return t
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: t.replace(/^@+/, "") })
  const raw = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!raw) throw new Error("Could not resolve username to wallet address.")
  return raw.startsWith("0x") ? raw : `0x${raw}`
}

type MoverRow = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  buy_price: number
  current_fmv: number
  pnl_pct: number
}

export async function GET(req: NextRequest) {
  try {
    const walletInput = req.nextUrl.searchParams.get("wallet")
    if (!walletInput) return NextResponse.json({ error: "wallet required" }, { status: 400 })

    const collectionSlug = req.nextUrl.searchParams.get("collection")?.trim() || ""
    const collectionUuid = COLLECTION_UUID_BY_SLUG[collectionSlug]
    if (!collectionUuid) {
      return NextResponse.json({ error: `unknown collection: ${collectionSlug}` }, { status: 400 })
    }

    const wallet = await resolveWallet(walletInput)

    if (collectionUuid !== TOPSHOT_UUID) {
      return NextResponse.json(
        { wallet, collection: collectionSlug, rows: [], reason: "cost_basis_unavailable" },
        { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
      )
    }

    // ── 1. Pull tracked acquisitions (buy_price > 0) ────────────────────────
    const PAGE = 1000
    type AcqRow = { nft_id: string; buy_price: string | number }
    const acqRows: AcqRow[] = []
    for (let page = 0; page < 50; page++) {
      const { data, error } = await (supabaseAdmin as any)
        .from("moment_acquisitions")
        .select("nft_id, buy_price")
        .eq("wallet", wallet)
        .eq("collection_id", TOPSHOT_UUID)
        .not("buy_price", "is", null)
        .gt("buy_price", 0)
        .range(page * PAGE, page * PAGE + PAGE - 1)
      if (error) throw new Error(error.message)
      const batch = (data ?? []) as AcqRow[]
      acqRows.push(...batch)
      if (batch.length < PAGE) break
    }

    // ── 2. Total wallet acquisition count for sample-size note ───────────────
    const { count: totalAcq } = await (supabaseAdmin as any)
      .from("moment_acquisitions")
      .select("nft_id", { count: "exact", head: true })
      .eq("wallet", wallet)
      .eq("collection_id", TOPSHOT_UUID)

    if (acqRows.length === 0) {
      return NextResponse.json(
        { wallet, collection: collectionSlug, rows: [], reason: "no_tracked_acquisitions" },
        { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
      )
    }

    // ── 3. Enrich with edition_key + denorm metadata via wallet_moments_cache ─
    const nftIds = acqRows.map((r) => r.nft_id).filter(Boolean)
    const cacheRows: Array<{ moment_id: string; edition_key: string | null; player_name: string | null; set_name: string | null; tier: string | null; serial_number: number | null }> = []
    for (let i = 0; i < nftIds.length; i += 500) {
      const slice = nftIds.slice(i, i + 500)
      const { data, error } = await (supabaseAdmin as any)
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, player_name, set_name, tier, serial_number")
        .eq("wallet_address", wallet)
        .eq("collection_id", TOPSHOT_UUID)
        .in("moment_id", slice)
      if (error) throw new Error(error.message)
      cacheRows.push(...(data ?? []))
    }
    const cacheByMoment = new Map(cacheRows.map((r) => [r.moment_id, r]))

    // ── 4. Map edition_key → edition uuid via editions.external_id ──────────
    const editionKeys = Array.from(new Set(cacheRows.map((r) => r.edition_key).filter(Boolean) as string[]))
    const editionMeta = new Map<string, { id: string; tier: string | null; player_name: string | null; set_name: string | null }>()
    for (let i = 0; i < editionKeys.length; i += 500) {
      const slice = editionKeys.slice(i, i + 500)
      const { data, error } = await (supabaseAdmin as any)
        .from("editions")
        .select("id, external_id, tier, player_name, set_name")
        .eq("collection_id", TOPSHOT_UUID)
        .in("external_id", slice)
      if (error) throw new Error(error.message)
      for (const e of data ?? []) editionMeta.set(e.external_id, e)
    }

    // ── 5. Most-recent fmv_snapshot per edition_id ───────────────────────────
    const editionUuids = Array.from(new Set(Array.from(editionMeta.values()).map((e) => e.id)))
    const fmvByEdition = new Map<string, number>()
    if (editionUuids.length > 0) {
      const { data, error } = await (supabaseAdmin as any).rpc("get_fmv_for_editions", {
        p_collection_id: TOPSHOT_UUID,
        p_edition_ids: editionUuids,
      })
      if (error) throw new Error(error.message)
      for (const row of (data ?? []) as Array<{ edition_id: string; fmv_usd: number | string }>) {
        fmvByEdition.set(row.edition_id, Number(row.fmv_usd) || 0)
      }
    }

    // ── 6. Fold rows ─────────────────────────────────────────────────────────
    type Row = MoverRow & { pnl_usd: number }
    const rows: Row[] = []
    let totalCost = 0
    let totalFmv = 0
    let wins = 0
    let losses = 0

    for (const acq of acqRows) {
      const cache = cacheByMoment.get(acq.nft_id)
      const editionKey = cache?.edition_key ?? null
      const ed = editionKey ? editionMeta.get(editionKey) : undefined
      const fmv = ed ? (fmvByEdition.get(ed.id) ?? 0) : 0
      const buy = Number(acq.buy_price) || 0
      if (buy <= 0) continue
      const pnl = fmv - buy
      const pnlPct = (pnl / buy) * 100
      totalCost += buy
      totalFmv += fmv
      if (pnl > 0) wins++
      else if (pnl < 0) losses++
      rows.push({
        player_name: ed?.player_name ?? cache?.player_name ?? null,
        set_name: ed?.set_name ?? cache?.set_name ?? null,
        tier: ed?.tier ?? cache?.tier ?? null,
        serial_number: cache?.serial_number ?? null,
        buy_price: Math.round(buy * 100) / 100,
        current_fmv: Math.round(fmv * 100) / 100,
        pnl_usd: Math.round(pnl * 100) / 100,
        pnl_pct: Math.round(pnlPct * 10) / 10,
      })
    }

    const trackedCount = rows.length
    const totalPnl = totalFmv - totalCost
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

    const sorted = [...rows].sort((a, b) => b.pnl_pct - a.pnl_pct)
    const gainers = sorted
      .filter((r) => r.pnl_pct > 0)
      .slice(0, 5)
      .map(({ pnl_usd, ...rest }) => rest)
    const losers = sorted
      .filter((r) => r.pnl_pct < 0)
      .slice(-5)
      .reverse()
      .map(({ pnl_usd, ...rest }) => rest)

    const sampleNote = `Cost basis tracked on ${trackedCount} of ${totalAcq ?? trackedCount} moments — only acquisitions with confirmed purchase prices are included`

    console.log("[wallet-cost-basis]", wallet, collectionSlug, trackedCount)

    return NextResponse.json(
      {
        wallet,
        collection: collectionSlug,
        summary: {
          tracked_count: trackedCount,
          total_cost_basis: Math.round(totalCost * 100) / 100,
          total_current_fmv: Math.round(totalFmv * 100) / 100,
          total_pnl_usd: Math.round(totalPnl * 100) / 100,
          total_pnl_pct: Math.round(totalPnlPct * 10) / 10,
          win_count: wins,
          loss_count: losses,
        },
        top_movers: { gainers, losers },
        sample_size_note: sampleNote,
      },
      { headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" } }
    )
  } catch (err) {
    console.log("[wallet-cost-basis] error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: err instanceof Error ? err.message : "Internal error" }, { status: 500 })
  }
}
