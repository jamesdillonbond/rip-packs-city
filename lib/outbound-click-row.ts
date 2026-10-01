// lib/outbound-click-row.ts
//
// ONE builder for an `outbound_clicks` row, shared by the two writers:
//   · POST /api/track-click — the site's click beacon (source "site")
//   · GET  /go/a/<delivery>  — the tracked redirect behind every alert buy link (source "alert")
//
// The row exists to be MATCHED to the marketplace sale that follows it
// (public.attribute_outbound_clicks → click_attributed_purchases, audit_20260930).
// That match is keyed on (collection, moment id) or (collection, edition key), and a
// moment id is unique only WITHIN a collection (#142) — so the collection is
// normalised here to the long-form `collections.slug`, and an unrecognised value is
// stored as NULL, never guessed (the DB job then reads the destination's host).
//
// The clamps mirror the anon_insert_outbound_clicks RLS CHECK caps: the writers use
// the service-role key, which bypasses them.

import { DB_SLUG_TO_SLUG, toDbSlug } from "@/lib/collections"
import { isBotUserAgent } from "@/lib/bot-ua"

export function clampStr(v: unknown, max: number): string | null {
  if (v == null) return null
  const s = String(v)
  if (!s) return null
  return s.slice(0, max)
}

export function clampNum(v: unknown, min: number, max: number): number | null {
  if (v == null) return null
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n)) return null
  if (n < min) return min
  if (n > max) return max
  return n
}

/** "nba-top-shot" | "nba_top_shot" → "nba_top_shot"; anything unknown → null (never a default). */
export function normalizeClickCollection(raw: unknown): string | null {
  const s = clampStr(raw, 64)?.trim().toLowerCase()
  if (!s) return null
  if (Object.prototype.hasOwnProperty.call(DB_SLUG_TO_SLUG, s)) return s
  return toDbSlug(s)
}

export type OutboundClickInput = {
  source: "site" | "alert"
  surface?: unknown
  destination?: unknown
  collection?: unknown
  linkKind?: unknown
  editionKey?: unknown
  momentId?: unknown
  playerName?: unknown
  setName?: unknown
  tier?: unknown
  serial?: unknown
  askPrice?: unknown
  fmv?: unknown
  discount?: unknown
  walletAddress?: unknown
  sessionId?: unknown
  buyUrl?: unknown
  alertDeliveryId?: string | null
  channel?: unknown
  userId?: string | null
  userAgent?: string | null
}

export function buildOutboundClickRow(i: OutboundClickInput) {
  const serial = clampNum(i.serial, 0, 10_000_000)
  const ua = clampStr(i.userAgent, 512)
  return {
    source: i.source,
    surface: clampStr(i.surface, 64),
    destination: clampStr(i.destination, 256),
    collection_slug: normalizeClickCollection(i.collection),
    link_kind: clampStr(i.linkKind, 32),
    edition_key: clampStr(i.editionKey, 64),
    moment_id: clampStr(i.momentId, 64),
    player_name: clampStr(i.playerName, 256),
    set_name: clampStr(i.setName, 256),
    tier: clampStr(i.tier, 32),
    serial: serial != null ? Math.round(serial) : null,
    ask_price_usd: clampNum(i.askPrice, 0, 10_000_000),
    fmv_usd: clampNum(i.fmv, 0, 10_000_000),
    discount_pct: clampNum(i.discount, -100, 100),
    // 64, not 32: a Solana (Candy) address is up to 44 base58 chars, and a
    // truncated address can never match the sale's buyer.
    wallet_address: clampStr(i.walletAddress, 64),
    session_id: clampStr(i.sessionId, 64),
    buy_url: clampStr(i.buyUrl, 4096),
    alert_delivery_id: i.alertDeliveryId ?? null,
    channel: clampStr(i.channel, 32),
    user_id: i.userId ?? null,
    user_agent: ua,
    bot_ua: isBotUserAgent(ua),
  }
}
