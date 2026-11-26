// lib/panini/linked-value.ts
//
// SERVER-ONLY. The Panini cards a member has linked (saved_collector_identities → Panini
// usernames), valued from each username's recorded collection value (panini_portfolio_daily,
// one row per walked collector per PT day, audit_20261026).
//
// Trevor, 2026-11-25: Panini belongs in the single Portfolio FMV ("Yes it should be"). This is
// the one reader behind every place that number is shown server-side — the public profile, the
// value history chart and the weekly email. The dashboard reads the same rows through
// /api/profile/collector-identities and sums them with lib/dashboard/panini-total.ts.
//
// HONESTY: a failed read is `failed: true`, never $0 cards. A username with no recorded day yet
// adds nothing and is counted in `unrecorded`. A recorded day with no priced cards (fmv_usd NULL)
// adds its cards and $0 of value — it is not a price.

import { boundedRead } from "@/lib/api/bounded-read"
import { getCollection } from "@/lib/collections"

export interface LinkedPaniniValue {
  /** Linked Panini usernames. */
  usernames: number
  /** Usernames with no recorded day yet. */
  unrecorded: number
  /** Cards across the newest recorded day of each username. */
  cards: number
  /** FMV of those cards, USD. */
  fmvUsd: number
  /** The read failed — the caller says so and adds nothing. */
  failed: boolean
}

export type PaniniDayRow = { username: string; day: string; cards: number | string | null; fmv_usd: number | string | null }

const EMPTY: LinkedPaniniValue = { usernames: 0, unrecorded: 0, cards: 0, fmvUsd: 0, failed: false }

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0
  return Number.isFinite(n) ? n : 0
}

/** Pure: the newest day per username, summed. */
export function sumNewestPaniniDays(usernames: string[], rows: PaniniDayRow[]): LinkedPaniniValue {
  const newest = new Map<string, PaniniDayRow>()
  for (const r of rows) {
    const cur = newest.get(r.username)
    if (!cur || r.day > cur.day) newest.set(r.username, r)
  }
  let cards = 0
  let fmv = 0
  let unrecorded = 0
  for (const u of usernames) {
    const r = newest.get(u)
    if (!r) { unrecorded++; continue }
    cards += num(r.cards)
    fmv += num(r.fmv_usd)
  }
  return { usernames: usernames.length, unrecorded, cards, fmvUsd: Math.round(fmv * 100) / 100, failed: false }
}

/** Pure: per date, the sum across usernames that have a row that day; a date none has is absent. */
export function paniniValueByDay(rows: PaniniDayRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.day, Math.round(((out.get(r.day) ?? 0) + num(r.fmv_usd)) * 100) / 100)
  return out
}

/** The Panini usernames this user has linked; null when the read failed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function linkedPaniniUsernames(sb: any, userId: string, label: string): Promise<string[] | null> {
  const paniniId = getCollection("panini-blockchain")?.supabaseCollectionId
  if (!paniniId) return []
  try {
    const { data, error } = await boundedRead(
      sb.from("saved_collector_identities").select("identity_value").eq("user_id", userId).eq("collection_id", paniniId),
      `${label}/saved_collector_identities`,
    )
    if (error || !Array.isArray(data)) return null
    return Array.from(new Set((data as Array<{ identity_value: unknown }>)
      .map((r) => (typeof r.identity_value === "string" ? r.identity_value : ""))
      .filter(Boolean)))
  } catch {
    return null
  }
}

/** Recorded days for these usernames from `sinceDay` (YYYY-MM-DD) on; null when the read failed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPaniniDays(sb: any, usernames: string[], sinceDay: string, label: string): Promise<PaniniDayRow[] | null> {
  if (usernames.length === 0) return []
  try {
    const { data, error } = await boundedRead(
      sb.from("panini_portfolio_daily").select("username, day, cards, fmv_usd").in("username", usernames).gte("day", sinceDay),
      `${label}/panini_portfolio_daily`,
    )
    if (error || !Array.isArray(data)) return null
    return data as PaniniDayRow[]
  } catch {
    return null
  }
}

/** YYYY-MM-DD, `days` before `now` (UTC calendar; the window is generous, not exact). */
export function dayBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
}

/** The member's linked Panini cards at their newest recorded value. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readLinkedPaniniValue(sb: any, userId: string, label: string, now: Date = new Date()): Promise<LinkedPaniniValue> {
  const usernames = await linkedPaniniUsernames(sb, userId, label)
  if (usernames === null) return { ...EMPTY, failed: true }
  if (usernames.length === 0) return EMPTY
  // The walk records daily; a username unwalked for 30 days is reported as unrecorded.
  const rows = await readPaniniDays(sb, usernames, dayBefore(now, 30), label)
  if (rows === null) return { ...EMPTY, usernames: usernames.length, failed: true }
  return sumNewestPaniniDays(usernames, rows)
}
