// lib/ufc-aptos.ts
//
// UFC Strike moved from Flow to Aptos (Trevor 2026-11-15: Aptos extends the existing ufc_strike
// collection). 2026-11-26 (Trevor: "view this from a chain-agnostic view … just on the specific
// assets in the binder, specific listings in sniper, specific sales on the moment's own pages, we
// give them a Flow or Aptos tag"): the binder is ONE table across both chains — Flow holdings from
// the wallet cache, Aptos holdings from /api/ufc/aptos-holdings — each row tagged with its chain,
// and one wallet value over both. No collection-wide migration messaging.
//
// ⚠ DELIBERATELY SEPARATE FROM lib/market-closed.ts: UFC left CLOSED_MARKETS on 2026-11-26.

import type { MomentRow } from "@/lib/collection/types"

/** Rarible's collection page for an Aptos collection id (redirects to og.rarible.com). */
export function raribleAptosCollectionUrl(aptosCollectionId: string | null | undefined): string | null {
  if (!aptosCollectionId || !/^0x[0-9a-f]{1,64}$/i.test(aptosCollectionId)) return null
  return `https://rarible.com/collection/aptos/${aptosCollectionId}/items`
}

export type AssetChain = "flow" | "aptos"
export const CHAIN_LABEL: Readonly<Record<AssetChain, string>> = { flow: "Flow", aptos: "Aptos" }

const UFC_SLUGS = new Set(["ufc", "ufc-strike"])

/** True for the UFC Strike binder: Flow holdings at current FMV + an On Aptos section. */
export function isUfcAptosBinder(collectionSlug: string | null | undefined): boolean {
  return !!collectionSlug && UFC_SLUGS.has(collectionSlug)
}

// ── Aptos wallets and venues on sales rows (2026-11-25) ──────────────────────────────────────
//
// UFC sales ingested from Aptos (sales.source = 'aptos_indexer_v1') carry 64-hex Aptos account
// addresses. The sales tables linked every buyer/seller into RPC's wallet analyzer,
// /<collection>/collection?wallet=<addr>, which reads FLOW wallets — an Aptos address there is
// a link to a wallet page that cannot describe that collector. Aptos addresses go to the Aptos
// explorer instead, and UFC's own two wallets are named (78 % of UFC's single Rarible listings
// on 2026-11-15 came from the store wallet).

const APTOS_ACCOUNT_RE = /^0x[0-9a-fA-F]{64}$/

/** A full-length Aptos account address (0x + 64 hex). Flow (16 hex) and EVM (40 hex) never match. */
export function isAptosAccountAddress(value: string | null | undefined): boolean {
  return !!value && APTOS_ACCOUNT_RE.test(value.trim())
}

/** UFC Strike's own Aptos wallets, by lowercase address. */
export const UFC_APTOS_KNOWN_WALLETS: Readonly<Record<string, string>> = {
  "0x8a94446716e60160571b930bd1097b31c7788decbe4d375802bebfc79d928e7f": "UFC Strike store",
  "0x80f686c7bba12a0fce839ff160cb69774715497288996b861528727ccd256cdb": "UFC Strike",
}

/**
 * Display for an Aptos address in a buyer/seller cell, or null when the address is not Aptos
 * (the caller keeps its own Flow/EVM/Solana path untouched).
 */
export function aptosWalletDisplay(
  address: string | null | undefined,
  name?: string | null,
): { label: string; href: string; title: string } | null {
  if (!address || !isAptosAccountAddress(address)) return null
  const a = address.trim().toLowerCase()
  const known = UFC_APTOS_KNOWN_WALLETS[a]
  const label = known ?? (name ? `@${name}` : `${a.slice(0, 6)}…${a.slice(-4)}`)
  return {
    label,
    href: `https://explorer.aptoslabs.com/account/${a}?network=mainnet`,
    title: `${known ? `${known} · ` : ""}${a} (Aptos)`,
  }
}

/**
 * Which chain a UFC Strike sale happened on (2026-11-26: every UFC sale row carries a Flow or Aptos tag).
 * Aptos sales come from aptos_indexer_v1 on Rarible / Tradeport and carry 64-hex Aptos accounts; every
 * other UFC sale (ufcstrike / flowty / flowverse, through 2026-05-13) is Flow. Reads only fields every
 * sales surface already carries, so the moment page needs no new RPC column.
 */
export function ufcSaleChain(s: { source?: string | null; marketplace?: string | null; buyer_address?: string | null; seller_address?: string | null }): AssetChain {
  if (s.source === "aptos_indexer_v1") return "aptos"
  const m = (s.marketplace ?? "").toLowerCase()
  if (m === "rarible" || m === "tradeport") return "aptos"
  if (isAptosAccountAddress(s.buyer_address) || isAptosAccountAddress(s.seller_address)) return "aptos"
  return "flow"
}

/** The Aptos venue's display name for an Aptos sale's marketplace; null when unknown. */
export function aptosVenueName(marketplace: string | null | undefined): string | null {
  const m = (marketplace ?? "").toLowerCase()
  return m === "rarible" ? "Rarible" : m === "tradeport" ? "Tradeport" : null
}

/** "Aptos · Rarible" for a sale ingested from Aptos; null for every other sale. */
export function aptosSaleVenue(source: string | null | undefined, marketplace: string | null | undefined): string | null {
  if (source !== "aptos_indexer_v1") return null
  const m = (marketplace ?? "").toLowerCase()
  const venue = m === "rarible" ? "Rarible" : m === "tradeport" ? "Tradeport" : null
  return venue ? `Aptos · ${venue}` : "Aptos"
}

/** One Moment held on Aptos, as /api/ufc/aptos-holdings returns it. */
export interface UfcAptosHolding {
  token_data_id: string
  edition_id: string | null
  edition_key?: string | null
  aptos_collection_id?: string | null
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  fmv_usd: number | null
}

/**
 * The binder's Aptos half, in three states plus loading (CLAUDE.md "Honesty"): "none" covers a wallet RPC has
 * not linked to an Aptos account yet as well as a linked one holding nothing — so no copy may claim "holds none
 * on Aptos"; "failed" is a read that did not answer, never a zero.
 */
export type UfcAptosState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "none" }
  | { status: "ok"; count: number; totalFmv: number | null; unpriced: number; capped: boolean }

/** A held Aptos Moment as a binder row: same table, same filters, tagged Aptos. */
export function aptosHoldingToRow(m: UfcAptosHolding): MomentRow {
  return {
    chain: "aptos",
    momentId: "aptos:" + m.token_data_id,
    playerName: m.player_name ?? m.name ?? "UFC Strike Moment",
    setName: m.set_name ?? "",
    tier: m.tier ?? undefined,
    serialNumber: m.serial_number ?? undefined,
    serial: m.serial_number ?? undefined,
    mintSize: m.circulation_count ?? undefined,
    mintCount: m.circulation_count ?? undefined,
    editionKey: m.edition_key ?? null,
    thumbnailUrl: m.thumbnail_url,
    fmv: m.fmv_usd,
    valuationScope: "Edition",
    raribleUrl: raribleAptosCollectionUrl(m.aptos_collection_id ?? null),
  }
}

/**
 * Empty-state copy for the UFC binder table, which lists BOTH chains (2026-11-26). "Not linked" and "linked,
 * holds none" are indistinguishable here, so the copy names what was searched and claims nothing more.
 */
export function ufcBinderEmptyCopy(aptos: UfcAptosState["status"]): string {
  if (aptos === "failed") return "No UFC Strike Moments found on Flow for this wallet, and its Aptos holdings couldn't load — search again to retry."
  if (aptos === "loading") return "No UFC Strike Moments found on Flow for this wallet. Checking Aptos…"
  return "No UFC Strike Moments found for this wallet on Flow or on any Aptos account RPC has linked to it."
}
