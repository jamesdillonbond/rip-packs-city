// lib/insights/drops-board.ts — the data behind /insights/drops ("Pack drops this week").
//
// One read: the pack calendar (lib/insights/pack-calendar.ts — Atlas pack book, Pinnacle Open
// Editions, Panini's store, Candy MLB's blog), plus which drops already have an RPC pack page so
// the board links only pages that exist (a dist 404s until it has a pack_distributions row).
// The calendar's honesty rules carry through: an unread source is NAMED, never shown as "no
// drops"; a delivered pre-order / draw is ended; no price or time is invented.

import { fetchPackCalendar, type PackCalendarDrop, type PackCalendarResult } from "@/lib/insights/pack-calendar"
import { DROP_CORRECTIONS, MANUAL_DROPS, type DropCorrection, type ManualDrop } from "@/lib/insights/manual-drops"

export interface DropsBoardItem extends PackCalendarDrop {
  /** RPC's pack page for this drop exists (pack_distributions row). Atlas drops only. */
  page_live: boolean
}

export interface DropsBoard {
  complete: PackCalendarResult["complete"]
  complete_at: PackCalendarResult["complete_at"]
  drops: DropsBoardItem[]
  announcements: PackCalendarResult["announcements"]
}

const ATLAS_COLLECTIONS = new Set<PackCalendarDrop["collection"]>(["nba_top_shot", "nfl_all_day", "laliga_golazos", "disney_pinnacle"])
const onPackBook = (d: PackCalendarDrop) => ATLAS_COLLECTIONS.has(d.collection) && d.kind !== "open_edition" && d.kind !== "trade_in"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchDropsBoard(sb: any, now = new Date(), fetchImpl: typeof fetch = fetch, manual: ManualDrop[] = MANUAL_DROPS, corrections: DropCorrection[] = DROP_CORRECTIONS): Promise<DropsBoard> {
  const cal = await fetchPackCalendar(sb, now, fetchImpl, manual, corrections)
  const ids = cal.drops.filter(onPackBook).map((d) => d.dist_id)
  const live = new Set<string>()
  if (ids.length) {
    const { data, error } = await sb.from("pack_distributions").select("dist_id").in("dist_id", ids).limit(1000)
    if (error) throw new Error(`pack_distributions: ${error.message}`)
    for (const r of (data ?? []) as { dist_id: string }[]) live.add(String(r.dist_id))
  }
  return {
    complete: cal.complete,
    complete_at: cal.complete_at,
    announcements: cal.announcements,
    drops: cal.drops.map((d) => ({ ...d, page_live: d.kind === "trade_in" ? true : onPackBook(d) && live.has(d.dist_id) })),
  }
}

/** Display order: open and upcoming first (priciest first), then what ended this week. */
export function orderDrops(drops: DropsBoardItem[]): { live: DropsBoardItem[]; ended: DropsBoardItem[] } {
  const byPrice = (a: DropsBoardItem, b: DropsBoardItem) =>
    (b.retail_usd ?? 0) - (a.retail_usd ?? 0) || a.start_time.localeCompare(b.start_time)
  return {
    live: drops.filter((d) => d.status !== "ended").sort(byPrice),
    ended: drops.filter((d) => d.status === "ended").sort((a, b) => (b.end_time ?? b.start_time).localeCompare(a.end_time ?? a.start_time)),
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
/** "Wed 12:30 PM PT" — always Pacific, the house rule for every RPC time. */
// A weekday alone names THIS week's day: "until Thu 8:59 PM PT" for a 12/31 close read as this
// Thursday (2026-11-15, the WNBA Finals Trade Ticket Pack). Past ~6 days out the date is added, and
// past 14 days only the date is given (an official "sale ends Dec 31" has no time to state).
export function whenPT(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const mins = p.minute === "00" ? "" : `:${p.minute}`
  const day = DAY_NAMES.includes(p.weekday) ? p.weekday : p.weekday.slice(0, 3)
  const ahead = d.getTime() - now
  if (ahead > 14 * 86_400_000) return `${day} ${p.month}/${p.day}`
  if (ahead > 6 * 86_400_000) return `${day} ${p.month}/${p.day} ${p.hour}${mins} ${p.dayPeriod} PT`
  return `${day} ${p.hour}${mins} ${p.dayPeriod} PT`
}

/** The status line, in each app's own words (Top Shot "pre-orders", Pinnacle "draw requests"). */
export function dropStatusLine(d: PackCalendarDrop): string {
  const word = d.collection === "disney_pinnacle" ? "Draw requests" : "Pre-orders"
  if (d.kind === "open_edition") return d.status === "ended" ? "Stopped minting" : "Minting now"
  if (d.kind === "capsule") {
    if (d.status === "ended") return "Capsules sold out or closed"
    if (d.status === "upcoming") return `Capsules on sale ${whenPT(d.start_time)}`
    return "Capsules on sale now"
  }
  if (d.kind === "trade_in") {
    if (d.status === "ended") return "Trade-ins closed"
    if (d.status === "upcoming") return `Trade-ins open ${whenPT(d.start_time)}`
    return d.end_time ? `Trade-ins close ${whenPT(d.end_time)}` : "Trade-ins open now"
  }
  if (d.status === "ended") return d.kind === "rsvp" ? `${word} closed` : "Ended"
  // An upcoming Pinnacle "RSVP" the official page has not confirmed may be a timed draw OR a
  // mystery-capsule sale (Dapper's book marks both RSVP; $49.95 Limited Editions have been each:
  // Stitch a draw, Predator capsules). "Opens" is true of both; a DROP_CORRECTIONS entry sets
  // kind "capsule" once the page says so.
  if (d.status === "upcoming" && d.kind === "rsvp" && d.collection === "disney_pinnacle") return `Opens ${whenPT(d.start_time)}`
  if (d.status === "upcoming") return `${d.kind === "rsvp" ? `${word} open` : "Drops"} ${whenPT(d.start_time)}`
  if (d.kind === "rsvp" && d.end_time) return `${word} close ${whenPT(d.end_time)}`
  const base = d.end_time ? `On sale until ${whenPT(d.end_time)}` : "On sale now"
  return d.low_stock ? `${base} · almost sold out` : base
}
