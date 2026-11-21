// lib/emails/alert-suggestion.ts
//
// "Get an alert on the player you own most of" — a one-line suggestion for the Day-1 and
// weekly emails (2026-11-20, Trevor: "Connect the repo and do it").
//
// Why: deal alerts are the one retention channel that fires on its own, and only two
// members outside the team had ever set one up (mxtthxw, webz_80; 0 price alerts ever).
// The alert form already takes a prefill from the Sniper; this sends a member to the same
// form with ONE player they actually hold filled in. Nothing is saved until they press Save.
//
// The pick: across the member's saved Flow wallets, the player whose Top Shot or All Day
// moments carry the most estimated value (summed). Only those two collections, because the
// suggestion promises "a <player> moment" — Pinnacle's subjects are characters and Golazos /
// UFC alerts carry no member demand yet. Measured 11-20: all 55 members with a saved Flow
// wallet get a pick (e.g. Cooper Flagg, LeBron James, Ausar Thompson).
//
// HONESTY: this is an optional suggestion, so every read failure returns null and the email
// simply omits the line — it never claims anything about the reader's account. A member who
// already has an active deal alert gets no suggestion (and a failed read of that also omits it).
//
// The PostgREST read is bounded at 1,000 rows (the platform clamp), ordered by value, so for
// a wallet larger than that the pick is "the top player among the 1,000 most valuable
// moments" — the right answer for a suggestion, and stated here rather than hidden.

import { supabaseAdmin } from "@/lib/supabase"
import { emailLink } from "./email-link"

export const ALERT_SUGGESTION_COLLECTIONS: Record<string, string> = {
  "95f28a17-224a-4025-96ad-adf8a4c63bfd": "Top Shot",
  "dee28451-5d62-409e-a1ad-a83f763ac070": "All Day",
}
/** The alert form's default (AlertsClient EMPTY_FORM.min_discount); the copy states it. */
export const SUGGESTED_MIN_DISCOUNT = 25

export type AlertSuggestion = { player: string; collectionId: string; collectionLabel: string }
export type HoldingRow = { player_name: string | null; fmv_usd: number | string | null; collection_id: string | null }

/** The player with the highest summed estimated value across the rows, or null. Pure. */
export function pickTopPlayer(rows: HoldingRow[]): AlertSuggestion | null {
  const sums = new Map<string, { player: string; collectionId: string; v: number }>()
  for (const r of rows) {
    const player = typeof r.player_name === "string" ? r.player_name.trim() : ""
    const cid = r.collection_id ?? ""
    const v = typeof r.fmv_usd === "number" ? r.fmv_usd : Number(r.fmv_usd)
    if (!player || !(cid in ALERT_SUGGESTION_COLLECTIONS) || !Number.isFinite(v) || v <= 0) continue
    const k = `${cid}|${player}`
    const cur = sums.get(k)
    if (cur) cur.v += v
    else sums.set(k, { player, collectionId: cid, v })
  }
  let best: { player: string; collectionId: string; v: number } | null = null
  for (const s of sums.values()) {
    // Ties break on the name so the pick is stable run to run.
    if (!best || s.v > best.v || (s.v === best.v && s.player < best.player)) best = s
  }
  return best ? { player: best.player.slice(0, 80), collectionId: best.collectionId, collectionLabel: ALERT_SUGGESTION_COLLECTIONS[best.collectionId] } : null
}

/** /alerts prefilled for a NEW alert on that player (AlertsClient reads it via readAlertPrefill). */
export function alertSuggestionUrl(origin: string, s: AlertSuggestion, medium: string): string {
  const q = new URLSearchParams({ from: "email", collection: s.collectionId, player: s.player })
  return emailLink(`${origin}/alerts?${q.toString()}`, medium, "alert_player")
}

export function alertSuggestionLine(s: AlertSuggestion): string {
  return `Get an email when a ${s.player} ${s.collectionLabel} moment lists at least ${SUGGESTED_MIN_DISCOUNT}% under its estimated value.`
}

/** Loads the suggestion for one member. Never throws; null on any failed or empty read. */
export async function loadAlertSuggestion(userId: string): Promise<AlertSuggestion | null> {
  try {
    const db = supabaseAdmin as any
    const subs = await db.from("alert_subscriptions").select("id").eq("owner_key", userId).eq("active", true).limit(1)
    if (subs.error || !Array.isArray(subs.data) || subs.data.length > 0) return null

    const sw = await db.from("saved_wallets").select("wallet_addr").eq("user_id", userId).limit(50)
    if (sw.error || !Array.isArray(sw.data)) return null
    const wallets = [...new Set(
      (sw.data as Array<{ wallet_addr: string | null }>)
        .map((r) => (typeof r.wallet_addr === "string" ? r.wallet_addr.trim() : ""))
        // Flow addresses only: hex, 0x-prefixed, case-insensitive (CLAUDE.md "Chain two").
        .filter((a) => /^0x[0-9a-fA-F]{16}$/.test(a))
        .map((a) => a.toLowerCase()),
    )]
    if (!wallets.length) return null

    const wmc = await db
      .from("wallet_moments_cache")
      .select("player_name,fmv_usd,collection_id")
      .in("wallet_address", wallets)
      .in("collection_id", Object.keys(ALERT_SUGGESTION_COLLECTIONS))
      .not("player_name", "is", null)
      .gt("fmv_usd", 0)
      .order("fmv_usd", { ascending: false })
      .order("id", { ascending: true })
      .limit(1000)
    if (wmc.error || !Array.isArray(wmc.data)) return null
    return pickTopPlayer(wmc.data as HoldingRow[])
  } catch {
    return null
  }
}

const escHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The weekly email's alert block (its dark mono style): HTML and plain-text lines; empty for null. */
export function buildWeeklyAlertBlock(origin: string, s: AlertSuggestion | null): { html: string; text: string[] } {
  if (!s) return { html: "", text: [] }
  const url = alertSuggestionUrl(origin, s, "weekly_digest")
  const html = `<div style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px 20px;margin-bottom:20px">
      <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px">Deal alert</div>
      <div style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.75)">${escHtml(alertSuggestionLine(s))} <a href="${escHtml(url)}" style="color:#fff;font-weight:700">Set up the alert →</a></div>
    </div>`
  return { html, text: ["", `Deal alert: ${alertSuggestionLine(s)} ${url}`] }
}
