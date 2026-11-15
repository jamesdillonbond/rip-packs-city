// lib/insights/manual-drops.ts — drops that no feed carries, entered by hand.
//
// Top Shot This trade-in packs (and similar) are not in the Atlas pack book, Panini's store or any
// chain lane, so the pack calendar cannot see them. Trevor, 11-08: the week's post, image, page and
// link card must all name the SAME drops ("I thought there were 9, like the post we did?"). An
// entry here flows into /api/public/insights/pack-calendar, /insights/drops, its OG card and the
// daily X draft.
//
// Rules for an entry:
//   - Every field comes from the drop's OFFICIAL page (nbatopshot.com …), never memory or a blog.
//     `source` records where it was read; `verified_at` when.
//   - `start_time`: the real open time if known, otherwise when it was verified (it only orders the
//     list and puts the drop in this week's window; no copy shows it for a trade-in).
//   - `end_time` is required: an entry without a close would read as "open" forever.
//   - Remove entries a week or so after they close (they render as "ended this week" until then).
import { textIncludes } from "@/lib/filter-match"
import type { DropStatus, PackCalendarDrop } from "@/lib/insights/pack-calendar"

export interface ManualDrop {
  id: string
  collection: PackCalendarDrop["collection"]
  title: string
  /**
   * "trade_in" (Top Shot This), or "rsvp" / "sale" for an announced Dapper drop the pack book has not
   * listed yet (2026 WNBA Finals, read 11-15 from blog.nbatopshot.com four days before it opened).
   */
  kind: "trade_in" | "rsvp" | "sale"
  /** One phrase of what you give for a pack, in the app's words. */
  detail: string
  slots?: number | null
  /**
   * Case-insensitive text of the FEED's title for this drop. Once a feed drop of the same collection
   * carries it, the feed row wins and this entry is skipped, so the drop is never listed twice.
   */
  feed_match?: string
  retail_usd: number | null
  start_time: string
  end_time: string
  detail_href: string
  source: string
  verified_at: string
}

export const MANUAL_DROPS: ManualDrop[] = [
  {
    id: "manual-tst-luka-2026-11",
    collection: "nba_top_shot",
    title: "Top Shot This: Luka Dončić",
    kind: "trade_in",
    detail: "trade in $10 of Luka Moments per pack",
    retail_usd: null,
    start_time: "2026-11-08T08:00:00Z",
    // Mon 11-09 3 PM ET = 12 PM PT (nbatopshot.com, read 11-08).
    end_time: "2026-11-09T20:00:00Z",
    detail_href: "/insights/trade-in",
    source: "nbatopshot.com Top Shot This page",
    verified_at: "2026-11-08",
  },
  // 2026 WNBA Finals (blog.nbatopshot.com/posts/2026-wnba-finals-drop-guide, read 2026-11-15; times ET
  // there). Early access opens Mon 11/16 3 PM ET (start below); public pre-orders Tue 11/17 3 PM ET.
  {
    id: "manual-wnba-finals-2026-case",
    collection: "nba_top_shot",
    title: "2026 WNBA Finals Case",
    kind: "rsvp",
    detail: "30 made · 12 packs, 78 Moments",
    slots: 78,
    retail_usd: 1250,
    start_time: "2026-11-16T20:00:00Z",
    end_time: "2026-11-18T20:00:00Z", // Wed 3 PM ET
    detail_href: "/insights/drops",
    feed_match: "Finals Case",
    source: "blog.nbatopshot.com 2026 WNBA Finals Drop Guide",
    verified_at: "2026-11-15",
  },
  {
    id: "manual-wnba-finals-2026-box",
    collection: "nba_top_shot",
    title: "2026 WNBA Finals Box",
    kind: "rsvp",
    detail: "200 made · 6 packs, 36 Moments",
    slots: 36,
    retail_usd: 195,
    start_time: "2026-11-16T20:00:00Z",
    end_time: "2026-11-18T21:00:00Z", // Wed 4 PM ET
    detail_href: "/insights/drops",
    feed_match: "Finals Box",
    source: "blog.nbatopshot.com 2026 WNBA Finals Drop Guide",
    verified_at: "2026-11-15",
  },
  {
    id: "manual-wnba-finals-2026-collector",
    collection: "nba_top_shot",
    title: "2026 WNBA Finals Collector Pack",
    kind: "rsvp",
    detail: "7 Moments, no duplicates",
    slots: 7,
    retail_usd: 25,
    start_time: "2026-11-16T20:00:00Z",
    end_time: "2026-11-18T22:00:00Z", // Wed 5 PM ET
    detail_href: "/insights/drops",
    feed_match: "Finals Collector",
    source: "blog.nbatopshot.com 2026 WNBA Finals Drop Guide",
    verified_at: "2026-11-15",
  },
  {
    id: "manual-wnba-finals-2026-trade-ticket",
    collection: "nba_top_shot",
    title: "2026 WNBA Finals Trade Ticket Pack",
    kind: "sale",
    detail: "10 trade tickets · 4 Moments",
    slots: 4,
    retail_usd: null,
    start_time: "2026-11-18T20:30:00Z", // Wed 3:30 PM ET
    end_time: "2027-01-01T04:59:00Z", // Thu 12/31 (ET), or sold out
    detail_href: "/insights/drops",
    feed_match: "Finals Trade Ticket",
    source: "blog.nbatopshot.com 2026 WNBA Finals Drop Guide",
    verified_at: "2026-11-15",
  },
]

// CORRECTIONS to a drop a feed DOES carry, read from the official page (Trevor, 11-08: "Double
// check and confirm the details"). Dapper's pack book (Atlas) marks Pinnacle's "Walt Disney Mugs
// Vol.1" mystery-capsule sale as a draw (dist_type RSVP), and a Pinnacle draw's end_time there is the
// waiting room's, not the draw's close (Friends-Giving Vol.2: book says 11/20, the draw closes 11/13).
// Only the fields given replace the feed's; same sourcing rules as MANUAL_DROPS.
export interface DropCorrection {
  dist_id: string
  title?: string
  kind?: "capsule" | "rsvp" | "sale"
  detail?: string
  end_time?: string
  source: string
  verified_at: string
}

export const DROP_CORRECTIONS: DropCorrection[] = [
  {
    dist_id: "8922",
    title: "Walt Disney Mugs Vol.1",
    kind: "capsule",
    detail: "6 Mickey & Friends mugs, 4 variants each · 98 Friends-Giving Vol.2 LE pins hidden inside (~1 in 18)",
    end_time: "2026-11-23T17:00:00Z",
    source: "disneypinnacle.com/releases",
    verified_at: "2026-11-08",
  },
  {
    dist_id: "8923",
    title: "Disney Mickey & Friends: Friends-Giving Vol.2",
    kind: "rsvp",
    detail: "Timed draw · requests close Fri 11/13 9 AM PT",
    // Timed draw: requests Thu 11/12 9 AM PT → Fri 11/13 9 AM PT.
    end_time: "2026-11-13T17:00:00Z",
    source: "disneypinnacle.com/releases",
    verified_at: "2026-11-08",
  },
]

/** Applies DROP_CORRECTIONS in place (matched by dist_id within the collection's feed). */
export function applyDropCorrections(drops: PackCalendarDrop[], now: Date, corrections: DropCorrection[] = DROP_CORRECTIONS): void {
  const t = now.getTime()
  for (const d of drops) {
    const c = corrections.find((x) => x.dist_id === d.dist_id)
    if (!c) continue
    if (c.title) d.title = c.title
    if (c.kind) d.kind = c.kind
    if (c.detail) d.detail = c.detail
    if (c.end_time) d.end_time = new Date(c.end_time).toISOString()
    const start = Date.parse(d.start_time)
    const end = d.end_time ? Date.parse(d.end_time) : NaN
    d.status = start > t ? "upcoming" : Number.isFinite(end) && end <= t ? "ended" : "open"
  }
}

const DAY_MS = 86_400_000

/** The manual entries that belong on this week's calendar: open, upcoming within 7 days, or closed in the last 7. */
export function buildManualDrops(now: Date, entries: ManualDrop[] = MANUAL_DROPS, feed: PackCalendarDrop[] = []): PackCalendarDrop[] {
  const t = now.getTime()
  const out: PackCalendarDrop[] = []
  for (const m of entries) {
    if (m.feed_match) {
      const needle = m.feed_match
      if (feed.some((d) => d.collection === m.collection && textIncludes(d.title, needle))) continue
    }
    const start = Date.parse(m.start_time)
    const end = Date.parse(m.end_time)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start > t + 7 * DAY_MS || end < t - 7 * DAY_MS) continue
    const status: DropStatus = start > t ? "upcoming" : end <= t ? "ended" : "open"
    out.push({
      collection: m.collection,
      dist_id: m.id,
      title: m.title,
      tier: null,
      pack_type: null,
      kind: m.kind,
      slots: m.slots ?? null,
      retail_usd: m.retail_usd,
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      status,
      detail_href: m.detail_href,
      detail: m.detail,
    })
  }
  return out
}
