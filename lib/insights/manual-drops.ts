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
import type { DropStatus, PackCalendarDrop } from "@/lib/insights/pack-calendar"

export interface ManualDrop {
  id: string
  collection: PackCalendarDrop["collection"]
  title: string
  kind: "trade_in"
  /** One phrase of what you give for a pack, in the app's words. */
  detail: string
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
]

const DAY_MS = 86_400_000

/** The manual entries that belong on this week's calendar: open, upcoming within 7 days, or closed in the last 7. */
export function buildManualDrops(now: Date, entries: ManualDrop[] = MANUAL_DROPS): PackCalendarDrop[] {
  const t = now.getTime()
  const out: PackCalendarDrop[] = []
  for (const m of entries) {
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
      slots: null,
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
