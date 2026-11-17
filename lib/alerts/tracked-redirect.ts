// lib/alerts/tracked-redirect.ts
//
// Data access for the tracked alert redirect (app/go/a/[id]/route.ts) — kept in lib/
// so the route file holds no DB client (server-page-data-access-ratchet).
//
// resolveAlertRedirect: re-derives the destination from the DELIVERY ROW with the same
// helpers the message used — never from the URL, so the redirect is not an open one.
// recordAlertClick: one outbound_clicks row (source "alert"); returns whether it landed.

import { createClient } from "@supabase/supabase-js"
import { dapperUrl, dealAsk, dealDetailUrl, dealFmv, nativeBuyLink, type Deal } from "@/lib/alerts/format"
import { buildOutboundClickRow } from "@/lib/outbound-click-row"

export const ALERT_REDIRECT_FALLBACK = "https://www.rippackscity.com/alerts"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AlertRedirectKind = "buy" | "dapper"
export type ResolvedAlertRedirect = {
  target: string
  deal: Deal | null
  delivery: { id: string; owner_key: string; channel: string } | null
}

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export async function resolveAlertRedirect(id: string, kind: AlertRedirectKind): Promise<ResolvedAlertRedirect> {
  const none = { target: ALERT_REDIRECT_FALLBACK, deal: null, delivery: null }
  if (!UUID_RE.test(id)) return none
  const { data, error } = await admin()
    .from("alert_deliveries")
    .select("id, owner_key, channel, alert_kind, payload")
    .eq("id", id)
    .maybeSingle()
  if (error) console.error("[go/a] delivery read failed:", error.message)
  if (error || !data || data.alert_kind !== "deal") return none
  const deal = ((data.payload as any)?.deal ?? null) as Deal | null
  if (!deal) return none
  const direct = kind === "dapper" ? dapperUrl(deal) : nativeBuyLink(deal)?.url ?? null
  return {
    // No such link on this deal → its RPC page (which carries its own links), not a guess.
    target: direct ?? dealDetailUrl(deal),
    deal,
    delivery: { id: data.id, owner_key: data.owner_key, channel: data.channel },
  }
}

export async function recordAlertClick(
  r: ResolvedAlertRedirect,
  kind: AlertRedirectKind,
  userAgent: string | null
): Promise<boolean> {
  const { deal, delivery, target } = r
  if (!deal || !delivery) return false
  const row = buildOutboundClickRow({
    source: "alert",
    surface: "alert",
    destination: kind === "dapper" ? "dapper_market_listing" : "native_marketplace_moment",
    collection: deal.collection_slug,
    linkKind: kind === "dapper" ? "dapper" : "moment",
    editionKey: deal.external_id,
    momentId: deal.nft_id,
    playerName: deal.player_name,
    setName: deal.set_name,
    tier: deal.tier,
    serial: deal.serial_number,
    askPrice: dealAsk(deal),
    fmv: dealFmv(deal),
    discount: deal.discount_pct,
    buyUrl: target,
    alertDeliveryId: delivery.id,
    channel: delivery.channel,
    userId: UUID_RE.test(delivery.owner_key) ? delivery.owner_key : null,
    userAgent,
  })
  const { error } = await admin().from("outbound_clicks").insert(row)
  if (error) console.error("[go/a] click insert failed (redirecting anyway):", error.message)
  return !error
}
