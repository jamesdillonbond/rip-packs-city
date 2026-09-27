// lib/panini/owner-cards.ts
//
// Parser for panini_owner_cards (Panini Collection tab, 2026-09-27). Pure and
// client-safe. A missing number is null, never 0; a payload without its counts is
// rejected (null) so the route answers "unavailable" instead of "0 cards".

import { paniniAssetUrl } from "@/lib/panini/assets"

export interface PaniniOwnerCard {
  sku: string
  editionKey: string | null
  serial: number | null
  mintCap: number | null
  isListed: boolean
  askUsd: number | null
  lastSaleUsd: number | null
  lastSaleAt: string | null
  seenAt: string | null
  flags: string[]
  playerName: string | null
  setName: string | null
  tier: string | null
  thumbnailUrl: string | null
  fmvUsd: number | null
}

export interface PaniniOwnerCards {
  username: string
  cardsSeen: number
  listedNow: number
  editions: number
  specialSerials: number
  fmvSeenUsd: number | null
  fmvPricedCards: number
  lastSeenAt: string | null
  cards: PaniniOwnerCard[]
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)

export function parsePaniniOwnerCards(raw: unknown): PaniniOwnerCards | null {
  const r = Array.isArray(raw) ? raw[0] : raw
  if (!r || typeof r !== "object") return null
  const o = r as Record<string, unknown>
  const cardsSeen = num(o.cards_seen)
  const listedNow = num(o.listed_now)
  const editions = num(o.editions)
  const specialSerials = num(o.special_serials)
  const fmvPricedCards = num(o.fmv_priced_cards)
  const username = str(o.username)
  if (username === null || cardsSeen === null || listedNow === null || editions === null || specialSerials === null || fmvPricedCards === null) {
    return null
  }
  const cards = (Array.isArray(o.cards) ? o.cards : []).map((c): PaniniOwnerCard => {
    const x = (c ?? {}) as Record<string, unknown>
    const flags: string[] = []
    if (x.is_number_one === true) flags.push("#1")
    if (x.is_jersey_mint === true) flags.push("jersey")
    if (x.is_perfect_mint === true) flags.push("last_mint")
    return {
      sku: String(x.sku ?? ""),
      editionKey: str(x.edition_external_id),
      serial: num(x.serial_number),
      mintCap: num(x.mint_cap),
      isListed: x.is_listed === true,
      askUsd: num(x.ask_usd),
      lastSaleUsd: num(x.last_sale_usd),
      lastSaleAt: str(x.last_sale_at),
      seenAt: str(x.captured_at),
      flags,
      playerName: str(x.player_name),
      setName: str(x.set_name),
      tier: str(x.tier),
      thumbnailUrl: paniniAssetUrl(str(x.thumbnail_url)),
      fmvUsd: num(x.fmv_usd),
    }
  })
  return {
    username,
    cardsSeen,
    listedNow,
    editions,
    specialSerials,
    fmvSeenUsd: num(o.fmv_seen_usd),
    fmvPricedCards,
    lastSeenAt: str(o.last_seen_at),
    cards,
  }
}
