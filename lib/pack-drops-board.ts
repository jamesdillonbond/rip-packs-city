// lib/pack-drops-board.ts
//
// Shared logic for the public /insights/pack-drops board (Shape A — read-only,
// zero custody). Discovers Vaultopolis re-pack drops from their open,
// unauthenticated API, rolls each drop's moments to distinct (player, set,
// series), prices them against RPC FMV via the SECDEF get_pack_drop_pricing RPC,
// and scores RPC pool / pack EV / value concentration / a verdict vs the FLOW
// listing price.
//
// Used by both:
//   - app/api/public/insights/pack-drops/route.ts  (JSON endpoint)
//   - app/insights/pack-drops/page.tsx              (server-rendered board)
//
// Vaultopolis API (no auth, fetched server-side, cached ~15min):
//   GET https://data.vaultopolis.com/api/drops                  → drop list (incl. listingPrice in FLOW)
//   GET https://data.vaultopolis.com/api/drops/{id}/composition → moments + their estimatedValue
//   GET https://data.vaultopolis.com/api/drops/{id}/odds        → fixed publication odds
//   GET https://data.vaultopolis.com/api/drops/{id}/sale-state  → listed / sold / soldOut
//
// RPC FMV match: each distinct (player, set, series) → canonical TS edition(s)
// via get_pack_drop_pricing (player_name ILIKE + set_name ILIKE + series, scoped
// to canonical int-pair-keyed Top Shot editions). Parallels/subeditions are
// priced at the BASE edition level today — the board flags them, it does not
// paper over the undervaluation (that's the serial-FMV layer's job).

import type { SupabaseClient } from "@supabase/supabase-js"

const VAULTOPOLIS_BASE = "https://data.vaultopolis.com/api/drops"

// How many sequential drop ids to probe when the list endpoint isn't usable.
// The list endpoint (/api/drops) is the primary discovery path; this is the
// fallback "probe 1..N until composition 404s" the handoff describes.
const MAX_PROBE_IDS = 30

export type VaultopolisAsset = {
  nftId: number
  pulled?: boolean
  valueTier: string | null
  playerName: string | null
  setName: string | null
  serialNumber: number | null
  momentCount: number | null
  series: number | null
  tier: string | null
  estimatedValue: number | null
  floorPrice: number | null
  parallel?: boolean
  subeditionId?: number | null
}

export type VaultopolisComposition = {
  dropId: number
  name: string | null
  displayName: string | null
  description: string | null
  packCount: number | null
  nftsPerPack: number | null
  totalNfts: number | null
  openedCount: number | null
  status: string | null
  assets: { TopShot?: VaultopolisAsset[] }
}

export type VaultopolisOddsTier = {
  tier: string
  count: number
  perCardProb: number
  perPackAtLeastOne: number
}

export type VaultopolisOdds = {
  slotTemplate?: string[][]
  tiers?: VaultopolisOddsTier[]
  hitRate?: { packs?: number; perPackProb?: number } | null
  publishedAt?: string | null
  methodology?: string | null
  disclaimer?: string | null
}

export type VaultopolisSaleState = {
  listed: number | null
  sold: number | null
  total: number | null
  saleOpen: boolean | null
  soldOut: boolean | null
  saleStartsAt?: string | null
}

export type VaultopolisDropListItem = {
  dropId: number
  displayName: string | null
  status: string | null
  packCount: number | null
  openedCount: number | null
  listedCount: number | null
  purchasedCount: number | null
  listingPrice: number | null
  listingCurrency: string | null
}

// One scored row: a distinct (player, set, series) within a drop.
export type ScoredEdition = {
  player: string | null
  set: string | null
  series: number | null
  count: number // how many of this edition are in the drop
  value_tier: string | null // Vaultopolis operator tier (Chase/Rare/Common)
  their_est: number | null // Vaultopolis estimatedValue (their number)
  rpc_fmv_avg: number | null // RPC FMV (avg over matched editions)
  confidence: string | null
  edition_matches: number // # canonical TS editions matched
  matched: boolean
  is_parallel: boolean // base-level priced; parallel premium not yet priced
  // contribution to the RPC pool (rpc_fmv_avg ?? their_est) * count
  pool_contribution: number
  used_fallback: boolean // priced off their_est because RPC had no match
}

export type ScoredDrop = {
  drop_id: number
  name: string | null
  description: string | null
  status: string | null
  pack_count: number | null
  opened_count: number | null
  nfts_per_pack: number | null
  total_nfts: number | null
  // pricing in FLOW (operator) + live USD conversion
  listing_price_flow: number | null
  listing_currency: string | null
  pack_price_flow: number | null // listing_price_flow / pack_count
  pack_price_usd: number | null // pack_price_flow * flowUsd (null if rate unknown)
  flow_usd: number | null
  // RPC scoring
  rpc_pool_usd: number
  rpc_pack_ev_usd: number | null // rpc_pool_usd / pack_count
  value_concentration_pct: number | null // % of pool in the single top edition
  matched_count: number
  total_distinct: number
  has_parallel: boolean
  verdict: string
  verdict_kind: "value" | "premium" | "fair" | "unknown"
  // sale-state + odds (passed through)
  sale_state: VaultopolisSaleState | null
  odds: VaultopolisOdds | null
  rows: ScoredEdition[]
}

async function fetchJson<T>(url: string, revalidateSec: number): Promise<T | null> {
  try {
    const r = await fetch(url, {
      next: { revalidate: revalidateSec },
      headers: { Accept: "application/json" },
    })
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// Live FLOW/USD via CoinGecko (mirrors the panini listings route's ETH/USD
// pattern). Best-effort: a miss just leaves USD figures null.
export async function fetchFlowUsd(): Promise<number | null> {
  const j = await fetchJson<{ flow?: { usd?: number } }>(
    "https://api.coingecko.com/api/v3/simple/price?ids=flow&vs_currencies=usd",
    300
  )
  const v = j?.flow?.usd
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null
}

// Discover live drops. Primary: the /api/drops list endpoint (gives the FLOW
// listingPrice too). Fallback: probe ids 1..N until composition 404s.
export async function discoverDropIds(): Promise<{ ids: number[]; list: VaultopolisDropListItem[] }> {
  const listed = await fetchJson<{ drops?: VaultopolisDropListItem[] }>(VAULTOPOLIS_BASE, 900)
  if (listed?.drops && Array.isArray(listed.drops) && listed.drops.length > 0) {
    const list = listed.drops
    const ids = list.map((d) => d.dropId).filter((n) => Number.isFinite(n))
    return { ids, list }
  }
  // Fallback probe: composition exists ⇒ keep going; first 404 stops us.
  const ids: number[] = []
  for (let id = 1; id <= MAX_PROBE_IDS; id++) {
    const comp = await fetchJson<VaultopolisComposition>(`${VAULTOPOLIS_BASE}/${id}/composition`, 900)
    if (!comp || !comp.assets) break
    ids.push(id)
  }
  return { ids, list: [] }
}

type PricingRpcRow = {
  player: string | null
  setname: string | null
  series: number | null
  edition_matches: number | string | null
  rpc_fmv_avg: number | string | null
  rpc_fmv_min: number | string | null
  rpc_fmv_max: number | string | null
  confidence: string | null
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function keyOf(player: string | null, set: string | null, series: number | null): string {
  return `${(player ?? "").toLowerCase()}|${(set ?? "").toLowerCase()}|${series ?? ""}`
}

// Roll a drop's TopShot assets to distinct (player, set, series), price against
// RPC FMV, and compute the pool / pack EV / concentration / verdict.
export async function scoreDrop(
  sb: SupabaseClient,
  comp: VaultopolisComposition,
  listItem: VaultopolisDropListItem | null,
  flowUsd: number | null
): Promise<ScoredDrop> {
  const assets = comp.assets?.TopShot ?? []

  // Distinct (player, set, series) with count + operator metadata (estimatedValue,
  // valueTier, parallel) carried from the first asset of each group.
  type Agg = {
    player: string | null
    set: string | null
    series: number | null
    count: number
    value_tier: string | null
    their_est: number | null
    is_parallel: boolean
  }
  const groups = new Map<string, Agg>()
  for (const a of assets) {
    const k = keyOf(a.playerName, a.setName, a.series)
    const existing = groups.get(k)
    if (existing) {
      existing.count++
      if (a.parallel || (a.subeditionId != null && a.subeditionId > 0)) existing.is_parallel = true
    } else {
      groups.set(k, {
        player: a.playerName,
        set: a.setName,
        series: a.series,
        count: 1,
        value_tier: a.valueTier,
        their_est: num(a.estimatedValue),
        is_parallel: !!a.parallel || (a.subeditionId != null && a.subeditionId > 0),
      })
    }
  }
  const aggs = [...groups.values()]

  // Price via the SECDEF RPC. NOTE: jsonb_to_recordset maps by COLUMN NAME, so
  // the input key MUST be `setname` (not `set`) — validated against drop #4.
  const pEds = aggs.map((g) => ({ player: g.player, setname: g.set, series: g.series }))
  let priced: PricingRpcRow[] = []
  try {
    const { data, error } = await sb.rpc("get_pack_drop_pricing", { p_eds: pEds })
    if (error) throw new Error(error.message)
    priced = (data ?? []) as PricingRpcRow[]
  } catch (e) {
    console.error("[pack-drops] get_pack_drop_pricing", e instanceof Error ? e.message : e)
    priced = []
  }
  const pricedByKey = new Map<string, PricingRpcRow>()
  for (const p of priced) pricedByKey.set(keyOf(p.player, p.setname, p.series), p)

  let pool = 0
  let matched = 0
  const rows: ScoredEdition[] = aggs.map((g) => {
    const p = pricedByKey.get(keyOf(g.player, g.set, g.series))
    const matchCount = num(p?.edition_matches) ?? 0
    const rpcAvg = matchCount > 0 ? num(p?.rpc_fmv_avg) : null
    const isMatched = matchCount > 0 && rpcAvg != null
    if (isMatched) matched++
    // Pool: RPC FMV when we matched, else fall back to their estimatedValue.
    const unit = isMatched ? (rpcAvg as number) : g.their_est ?? 0
    const contribution = unit * g.count
    pool += contribution
    return {
      player: g.player,
      set: g.set,
      series: g.series,
      count: g.count,
      value_tier: g.value_tier,
      their_est: g.their_est,
      rpc_fmv_avg: rpcAvg,
      confidence: isMatched ? p?.confidence ?? null : null,
      edition_matches: matchCount,
      matched: isMatched,
      is_parallel: g.is_parallel,
      pool_contribution: contribution,
      used_fallback: !isMatched && g.their_est != null,
    }
  })

  const packCount = comp.packCount ?? listItem?.packCount ?? null
  const packEv = packCount && packCount > 0 ? pool / packCount : null

  // Value concentration: % of the pool in the single highest-contributing edition.
  const topContribution = rows.reduce((m, r) => Math.max(m, r.pool_contribution), 0)
  const valueConcentration = pool > 0 ? (topContribution / pool) * 100 : null

  // Pricing in FLOW (operator) + live USD.
  const listingPriceFlow = num(listItem?.listingPrice)
  const listingCurrency = listItem?.listingCurrency ?? "flow"
  const packPriceFlow = listingPriceFlow != null && packCount && packCount > 0 ? listingPriceFlow / packCount : null
  const packPriceUsd = packPriceFlow != null && flowUsd != null ? packPriceFlow * flowUsd : null

  // Verdict vs the USD pack price. Only meaningful when we have both a USD pack
  // price and a pack EV.
  let verdict = "Pricing unavailable — Vaultopolis hasn't published a FLOW price for this drop yet."
  let verdictKind: ScoredDrop["verdict_kind"] = "unknown"
  if (packEv != null && packPriceUsd != null) {
    const ratio = packPriceUsd > 0 ? packEv / packPriceUsd : null
    if (ratio != null && ratio >= 1.15) {
      verdict = `RPC values this pack at ~$${packEv.toFixed(2)} vs ~$${packPriceUsd.toFixed(2)} to buy — RPC FMV exceeds the ask.`
      verdictKind = "value"
    } else if (ratio != null && ratio <= 0.85) {
      verdict = `RPC values this pack at ~$${packEv.toFixed(2)} vs ~$${packPriceUsd.toFixed(2)} to buy — the ask is above RPC FMV.`
      verdictKind = "premium"
    } else {
      verdict = `RPC values this pack at ~$${packEv.toFixed(2)} vs ~$${packPriceUsd.toFixed(2)} to buy — roughly fair.`
      verdictKind = "fair"
    }
  } else if (packEv != null) {
    verdict = `RPC values this pack's contents at ~$${packEv.toFixed(2)} per pack.`
    verdictKind = "unknown"
  }

  return {
    drop_id: comp.dropId,
    name: comp.displayName ?? comp.name ?? `Drop #${comp.dropId}`,
    description: comp.description,
    status: comp.status ?? listItem?.status ?? null,
    pack_count: packCount,
    opened_count: comp.openedCount ?? listItem?.openedCount ?? null,
    nfts_per_pack: comp.nftsPerPack,
    total_nfts: comp.totalNfts,
    listing_price_flow: listingPriceFlow,
    listing_currency: listingCurrency,
    pack_price_flow: packPriceFlow,
    pack_price_usd: packPriceUsd,
    flow_usd: flowUsd,
    rpc_pool_usd: Number(pool.toFixed(2)),
    rpc_pack_ev_usd: packEv != null ? Number(packEv.toFixed(2)) : null,
    value_concentration_pct: valueConcentration != null ? Number(valueConcentration.toFixed(1)) : null,
    matched_count: matched,
    total_distinct: aggs.length,
    has_parallel: rows.some((r) => r.is_parallel),
    verdict,
    verdict_kind: verdictKind,
    sale_state: null, // filled by the caller (separate fetch)
    odds: null, // filled by the caller (separate fetch)
    rows: rows.sort((a, b) => b.pool_contribution - a.pool_contribution),
  }
}

// Top-level orchestrator: discover → fetch each drop's composition/odds/sale-state
// → score. Returns drops sorted live-first then newest id. Skips cancelled drops
// and drops with no TopShot assets.
export async function fetchScoredDrops(sb: SupabaseClient): Promise<ScoredDrop[]> {
  const [{ ids, list }, flowUsd] = await Promise.all([discoverDropIds(), fetchFlowUsd()])
  const listById = new Map<number, VaultopolisDropListItem>()
  for (const d of list) listById.set(d.dropId, d)

  const scored: ScoredDrop[] = []
  for (const id of ids) {
    const li = listById.get(id) ?? null
    // Skip drops that are cancelled or have no packs — nothing to score.
    if (li && li.status === "cancelled") continue
    const [comp, odds, saleState] = await Promise.all([
      fetchJson<VaultopolisComposition>(`${VAULTOPOLIS_BASE}/${id}/composition`, 900),
      fetchJson<VaultopolisOdds>(`${VAULTOPOLIS_BASE}/${id}/odds`, 900),
      fetchJson<VaultopolisSaleState>(`${VAULTOPOLIS_BASE}/${id}/sale-state`, 900),
    ])
    if (!comp || !comp.assets?.TopShot || comp.assets.TopShot.length === 0) continue
    const s = await scoreDrop(sb, comp, li, flowUsd)
    s.odds = odds
    s.sale_state = saleState
    scored.push(s)
  }

  // Live / sale-open drops first, then by newest drop id.
  scored.sort((a, b) => {
    const aLive = a.sale_state?.saleOpen ? 1 : 0
    const bLive = b.sale_state?.saleOpen ? 1 : 0
    if (aLive !== bLive) return bLive - aLive
    return b.drop_id - a.drop_id
  })
  return scored
}
