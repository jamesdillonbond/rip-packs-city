// app/go/a/[id]/route.ts
//
// The tracked redirect behind every marketplace link in a deal alert
// (Telegram / Discord / email — lib/alerts/format.ts `trackedHref`).
//
//   GET /go/a/<alert_deliveries.id>?l=buy     → the moment on its native marketplace
//   GET /go/a/<alert_deliveries.id>?l=dapper  → the Dapper listing
//
// It records the click in outbound_clicks (source "alert", the delivery, its channel,
// its owner, the collection, the moment) and 302s. public.attribute_outbound_clicks
// then matches the click to the sale that followed (audit_20260930).
//
// ⛔ NOT AN OPEN REDIRECT. The destination is re-derived from the DELIVERY ROW with
// the same helpers the message used (nativeBuyLink / dapperUrl); nothing in the URL
// but an id and a two-value switch is read. An unknown id, a non-deal delivery or a
// deal with no such link goes to the RPC page for it, or /alerts — never elsewhere.
//
// ⚠ A FAILED LOG NEVER BLOCKS THE PURCHASE. The user is mid-tap on a deal; if the
// insert fails we still redirect, and say so in the server log. The click is then
// missing, which undercounts — the safe direction for an attribution number.
// ⚠ HEAD is answered without logging: link-preview fetchers and mail scanners probe
// with HEAD, and a probe is not a click. GET probes are recorded with bot_ua set.

import { NextRequest, NextResponse } from "next/server"
import {
  ALERT_REDIRECT_FALLBACK,
  recordAlertClick,
  resolveAlertRedirect,
  type AlertRedirectKind,
  type ResolvedAlertRedirect,
} from "@/lib/alerts/tracked-redirect"

export const dynamic = "force-dynamic"

function go(url: string) {
  const res = NextResponse.redirect(url, 302)
  res.headers.set("Cache-Control", "no-store")
  res.headers.set("X-Robots-Tag", "noindex")
  return res
}

function kindOf(req: NextRequest): AlertRedirectKind {
  return req.nextUrl.searchParams.get("l") === "dapper" ? "dapper" : "buy"
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const kind = kindOf(req)
  let resolved: ResolvedAlertRedirect
  try {
    resolved = await resolveAlertRedirect(id, kind)
  } catch (e) {
    console.error("[go/a] resolve threw:", e instanceof Error ? e.message : String(e))
    return go(ALERT_REDIRECT_FALLBACK)
  }
  try {
    await recordAlertClick(resolved, kind, req.headers.get("user-agent"))
  } catch (e) {
    console.error("[go/a] click log threw (redirecting anyway):", e instanceof Error ? e.message : String(e))
  }
  return go(resolved.target)
}

// A probe is not a click: resolve the same destination, record nothing.
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    return go((await resolveAlertRedirect(id, kindOf(req))).target)
  } catch {
    return go(ALERT_REDIRECT_FALLBACK)
  }
}
