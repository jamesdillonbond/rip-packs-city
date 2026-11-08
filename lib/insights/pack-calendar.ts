// lib/insights/pack-calendar.ts
//
// The week's Dapper pack drops — Top Shot and All Day, plus Golazos and Pinnacle once the book
// walks them (`laliga` / `disney`, migration audit_20261108_atlas_pack_book_adds_golazos_and_pinnacle) —
// from the Atlas pack book
// (`atlas_pack_market`, walked every 15 min by `atlas_pack_market_tick`, migration
// 20261101022135). Built 2026-11-08 for the @RipPacksCity "drops this week" post
// (docs/social/x-calendar.md): no other RPC table lists a drop before its first pack sells.
//
// HONESTY. The book is only published from its last COMPLETE pass — the same rule as
// `atlas_pack_book()` — so a pass caught half-way never reads as "fewer drops". With no
// complete pass the calendar is `complete: false` and has no rows; the caller says so rather
// than posting an empty week. A drop's window is Dapper's own `start_time` / `end_time`; for an
// RSVP drop that window is the RSVP, so `kind` carries the distinction and copy must not call
// an RSVP close a sale.
//
// WHICH PRODUCTS. The book's own state rows decide: a product is read when it has a
// `atlas_pack_market_state` row, so adding one in the DB widens the calendar with no code change.
// `complete` is true only when EVERY walked product has a complete pass; drops come only from
// products that do, and `complete_at` names the one that does not, so a half-walked product is
// reported as unread, never as a week without drops.
//
// NOT COVERED (2026-11-08): Panini (its `panini_products.first_seen_at` is DISCOVERY time — six
// Entertainment products were all "first seen" 11-08 when the runner learned the filter — not a
// release date), Candy MLB (no drop schedule is ingested; packs are secondary-market only) and UFC
// Strike (market closed). Say so; never imply they had no drops.

export type PackCalendarProduct = "nba" | "nfl" | "laliga" | "disney"

export interface PackCalendarSourceRow {
  product: string
  dist_id: string
  title: string | null
  tier: string | null
  pack_type: string | null
  dist_type: string | null
  slots: number | null
  retail_usd: number | string | null
  start_time: string | null
  end_time: string | null
  image_url: string | null
}

export type DropStatus = "upcoming" | "open" | "ended"

export interface PackCalendarDrop {
  collection: "nba_top_shot" | "nfl_all_day" | "laliga_golazos" | "disney_pinnacle"
  dist_id: string
  title: string
  tier: string | null
  pack_type: string | null
  /** "rsvp" when Dapper sells it by reservation (the window is the RSVP), else "sale". */
  kind: "rsvp" | "sale"
  slots: number | null
  retail_usd: number | null
  start_time: string
  end_time: string | null
  status: DropStatus
  /** RPC's own pack page; it 404s until the dist has a pack_distributions row. */
  detail_href: string
}

const COLLECTION: Record<PackCalendarProduct, PackCalendarDrop["collection"]> = {
  nba: "nba_top_shot",
  nfl: "nfl_all_day",
  laliga: "laliga_golazos",
  disney: "disney_pinnacle",
}
const URL_SLUG: Record<PackCalendarProduct, string> = {
  nba: "nba-top-shot",
  nfl: "nfl-all-day",
  laliga: "laliga-golazos",
  disney: "disney-pinnacle",
}
const isProduct = (p: string): p is PackCalendarProduct => Object.prototype.hasOwnProperty.call(COLLECTION, p)

const DAY_MS = 86_400_000

/**
 * Which drops belong on "this week": anything starting within `daysBack` before now and
 * `daysAhead` after it, plus anything that started earlier and has a closing time still ahead. A row with no
 * start time, or Atlas's year-2000 placeholder, is not a drop we can date and is left out.
 */
export function buildPackCalendar(
  rows: PackCalendarSourceRow[],
  now: Date,
  opts: { daysBack?: number; daysAhead?: number } = {},
): PackCalendarDrop[] {
  const back = now.getTime() - (opts.daysBack ?? 7) * DAY_MS
  const ahead = now.getTime() + (opts.daysAhead ?? 7) * DAY_MS
  const out: PackCalendarDrop[] = []
  for (const r of rows) {
    if (!isProduct(r.product)) continue
    if (!r.start_time || !/^[0-9]+$/.test(r.dist_id)) continue
    const start = Date.parse(r.start_time)
    if (!Number.isFinite(start) || new Date(start).getUTCFullYear() < 2015) continue
    const end = r.end_time ? Date.parse(r.end_time) : NaN
    // An earlier start counts only with a real closing time still ahead: a dist with no end
    // (reward packs, standing offers) would otherwise read as "open this week" forever.
    const stillOpen = start <= now.getTime() && Number.isFinite(end) && end > now.getTime()
    const inWindow = start >= back && start <= ahead
    if (!inWindow && !(stillOpen && start >= now.getTime() - 60 * DAY_MS)) continue
    const status: DropStatus =
      start > now.getTime() ? "upcoming" : Number.isFinite(end) && end <= now.getTime() ? "ended" : "open"
    const retail = r.retail_usd == null ? null : Number(r.retail_usd)
    out.push({
      collection: COLLECTION[r.product],
      dist_id: r.dist_id,
      title: (r.title ?? "").trim() || `Pack #${r.dist_id}`,
      tier: r.tier,
      pack_type: r.pack_type,
      kind: (r.dist_type ?? "").toUpperCase() === "RSVP" ? "rsvp" : "sale",
      slots: r.slots,
      retail_usd: retail != null && Number.isFinite(retail) && retail > 0 ? retail : null,
      start_time: new Date(start).toISOString(),
      end_time: Number.isFinite(end) ? new Date(end).toISOString() : null,
      status,
      detail_href: `/${URL_SLUG[r.product]}/pack/dist/${r.dist_id}`,
    })
  }
  return out.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.dist_id.localeCompare(b.dist_id))
}

export interface PackCalendarResult {
  /** Every walked product (and Top Shot + All Day always) has a complete pass. */
  complete: boolean
  /** When each walked product's newest complete pass finished; null = never (that product is unread). */
  complete_at: Partial<Record<PackCalendarProduct, string | null>>
  /** Drops from the products that DO have a complete pass. */
  drops: PackCalendarDrop[]
}

// Top Shot and All Day are always expected; a missing state row for them is an unread book.
const REQUIRED: PackCalendarProduct[] = ["nba", "nfl"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchPackCalendar(sb: any, now = new Date()): Promise<PackCalendarResult> {
  const { data: state, error: stateErr } = await sb
    .from("atlas_pack_market_state")
    .select("product, last_complete_pass_started_at, last_complete_at")
  if (stateErr) throw new Error(`atlas_pack_market_state: ${stateErr.message}`)

  const walked = new Set<PackCalendarProduct>(REQUIRED)
  for (const s of (state ?? []) as { product: string }[]) if (isProduct(s.product)) walked.add(s.product)

  const complete_at: Partial<Record<PackCalendarProduct, string | null>> = {}
  const rows: PackCalendarSourceRow[] = []
  let complete = true
  for (const product of [...walked].sort()) {
    const st = (state ?? []).find((s: { product: string }) => s.product === product)
    complete_at[product] = st?.last_complete_pass_started_at ? (st.last_complete_at ?? null) : null
    if (!st?.last_complete_pass_started_at) {
      complete = false
      continue
    }
    // Only rows the last complete pass (or a newer one) saw — the atlas_pack_book() rule.
    const since = new Date(now.getTime() - 60 * DAY_MS).toISOString()
    const { data, error } = await sb
      .from("atlas_pack_market")
      .select("product, dist_id, title, tier, pack_type, dist_type, slots, retail_usd, start_time, end_time, image_url")
      .eq("product", product)
      .gte("pass_started_at", st.last_complete_pass_started_at)
      .gte("start_time", since)
      .order("start_time", { ascending: true })
      .order("dist_id", { ascending: true })
      .limit(1000)
    if (error) throw new Error(`atlas_pack_market(${product}): ${error.message}`)
    // A full page means the 60-day slice was cut: a partial list is not the week's drops.
    if ((data ?? []).length >= 1000) throw new Error(`atlas_pack_market(${product}): 1000-row page full`)
    rows.push(...((data ?? []) as PackCalendarSourceRow[]))
  }
  return { complete, complete_at, drops: buildPackCalendar(rows, now) }
}
