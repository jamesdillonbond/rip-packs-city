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
// PANINI (2026-11-08): `panini_pack_drops` — Panini's own release date per pack, from the store
// `packs` / `packsTimeline` lists the residential runner captures (lib/panini/pack-drops.ts). Its
// `panini_products.first_seen_at` is NOT used: that is when our runner discovered a product. The
// table is "read" only while the runner has refreshed it in the last PANINI_FRESH_HOURS.
//
// CANDY MLB (2026-11-08): Candy's own store has been offline since its October wallet migration
// (candy.io: "The new candy.io is on its way"), so no store lists a drop. Candy announces drops on
// its blog, so the calendar carries `announcements` — drop-titled posts from blog.candy.io's RSS in
// the window, linked — never a fabricated date or price.
//
// PINNACLE OPEN EDITIONS (2026-11-08): not packs — no PackNFT, no Atlas book row. While an Open
// Edition is on sale its pins are minted straight into buyers' wallets, so the only record is
// `pinnacle_mint_events` (get_pinnacle_open_edition_drops). It is seen only once it is MINTING:
// no announced start, no price, no end. "open" = a pin minted in the last OE_MINTING_HOURS; a set
// that stopped minting has "ended" (Gargoyles Vol.1 stopped on the minute its drop closed). The
// source is unread unless the mint lane is at the chain head (`lane_as_of`), because only then does
// "nothing minting" mean nothing is on sale.
//
// UFC STRIKE: market closed; not read. Say so; never imply it had no drops.

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
  collection: "nba_top_shot" | "nfl_all_day" | "laliga_golazos" | "disney_pinnacle" | "panini_blockchain"
  dist_id: string
  title: string
  tier: string | null
  pack_type: string | null
  /**
   * "rsvp" when Dapper sells it by reservation (the window is the RSVP), "open_edition" for a Pinnacle
   * Open Edition seen minting (no price, no announced end), else "sale".
   */
  kind: "rsvp" | "sale" | "open_edition"
  slots: number | null
  retail_usd: number | null
  start_time: string
  end_time: string | null
  status: DropStatus
  /** RPC's own pack page; it 404s until the dist has a pack_distributions row. */
  detail_href: string
  /** Panini only: the store's sport ("BASKETBALL", "ENTERTAINMENT", …). */
  sport?: string | null
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
/** A drop that started before the week is listed only if it CLOSES within this many days. */
export const OPEN_CLOSE_DAYS = 14

/**
 * Which drops belong on "this week": anything starting within `daysBack` before now and
 * `daysAhead` after it, plus anything that started earlier and closes within OPEN_CLOSE_DAYS. A row with no
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
    // An earlier start counts only with a real closing time still ahead and within OPEN_CLOSE_DAYS:
    // a dist with no end (reward packs, standing offers) or a year-long sale (Pinnacle's
    // "Star Wars Halloween Vol.1" closes 2027-10) would otherwise read as "open this week" every week.
    const stillOpen = start <= now.getTime() && Number.isFinite(end) && end > now.getTime() && end <= now.getTime() + OPEN_CLOSE_DAYS * DAY_MS
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

export interface PackCalendarAnnouncement {
  collection: "candy_mlb"
  title: string
  url: string
  published_at: string
}

export type PackCalendarSource = PackCalendarProduct | "panini" | "candy" | "pinnacle_oe"

export interface PackCalendarResult {
  /** Every source read (Top Shot + All Day always expected). */
  complete: boolean
  /** As-of per source; null = that source is UNREAD (its drops are missing, not absent). */
  complete_at: Partial<Record<PackCalendarSource, string | null>>
  /** Drops from the sources that were read. */
  drops: PackCalendarDrop[]
  /** Candy MLB: drop announcements from its blog (no store lists Candy drops). */
  announcements: PackCalendarAnnouncement[]
}

// ── Panini ────────────────────────────────────────────────────────────────────────────
export const PANINI_FRESH_HOURS = 36

export interface PaniniDropSourceRow {
  pack_id: string
  name: string
  sport?: string | null
  price_usd: number | string | null
  cards_per_pack: number | null
  start_at: string | null
  end_at: string | null
  in_stock: boolean | null
  is_available: boolean | null
  last_seen_at: string
}

/** Same window rule as buildPackCalendar; a pack Panini no longer has in stock has ENDED (sold out). */
export function buildPaniniDrops(rows: PaniniDropSourceRow[], now: Date, opts: { daysBack?: number; daysAhead?: number } = {}): PackCalendarDrop[] {
  const back = now.getTime() - (opts.daysBack ?? 7) * DAY_MS
  const ahead = now.getTime() + (opts.daysAhead ?? 7) * DAY_MS
  const out: PackCalendarDrop[] = []
  for (const r of rows) {
    if (!r.start_at || !/^[0-9]+$/.test(r.pack_id)) continue
    const start = Date.parse(r.start_at)
    if (!Number.isFinite(start)) continue
    const end = r.end_at ? Date.parse(r.end_at) : NaN
    const stillOpen = start <= now.getTime() && Number.isFinite(end) && end > now.getTime() && end <= now.getTime() + OPEN_CLOSE_DAYS * DAY_MS && r.in_stock !== false
    if (!(start >= back && start <= ahead) && !stillOpen) continue
    const status: DropStatus =
      start > now.getTime() ? "upcoming" : r.in_stock === false || (Number.isFinite(end) && end <= now.getTime()) ? "ended" : "open"
    const price = r.price_usd == null ? null : Number(r.price_usd)
    out.push({
      collection: "panini_blockchain",
      dist_id: r.pack_id,
      title: r.name.replace(/^\d{4}(?:-\d{2})? Panini NFT /, "").trim() || r.name,
      tier: null,
      pack_type: null,
      kind: "sale",
      slots: r.cards_per_pack,
      retail_usd: price != null && Number.isFinite(price) && price > 0 ? price : null,
      start_time: new Date(start).toISOString(),
      end_time: Number.isFinite(end) ? new Date(end).toISOString() : null,
      status,
      detail_href: "/panini-blockchain/packs",
      sport: r.sport ?? null,
    })
  }
  return out
}

// ── Pinnacle Open Editions ──────────────────────────────────────────────────────────
/** A set with a pin minted this recently is "minting now". */
export const OE_MINTING_HOURS = 24

export interface PinnacleOpenEditionSet {
  set_key: string
  set_name: string | null
  edition_type: string | null
  pins: number | string
  first_mint_at: string
  last_mint_at: string
}

/** "Disney • Gargoyles Vol.1" + "Open Edition" → "Gargoyles Vol.1 (Open Edition)". */
export function openEditionTitle(setName: string | null, editionType: string | null, setKey: string): string {
  const name = (setName ?? "").split("•").pop()?.trim() || setKey
  return `${name} (${(editionType ?? "").trim() || "Open Edition"})`
}

/** Open Edition sets minting now, or that started minting this week and have stopped (ended). */
export function buildPinnacleOpenEditionDrops(sets: PinnacleOpenEditionSet[], now: Date, opts: { daysBack?: number } = {}): PackCalendarDrop[] {
  const back = now.getTime() - (opts.daysBack ?? 7) * DAY_MS
  const out: PackCalendarDrop[] = []
  for (const s of sets) {
    const first = Date.parse(s.first_mint_at)
    const last = Date.parse(s.last_mint_at)
    if (!s.set_key || !Number.isFinite(first) || !Number.isFinite(last)) continue
    const minting = last >= now.getTime() - OE_MINTING_HOURS * 3_600_000
    if (!minting && first < back) continue
    out.push({
      collection: "disney_pinnacle",
      dist_id: s.set_key,
      title: openEditionTitle(s.set_name, s.edition_type, s.set_key),
      tier: "open_edition",
      pack_type: null,
      kind: "open_edition",
      slots: null,
      retail_usd: null,
      start_time: new Date(first).toISOString(),
      // the last mint is when it stopped — only once it has stopped
      end_time: minting ? null : new Date(last).toISOString(),
      status: minting ? "open" : "ended",
      detail_href: "/disney-pinnacle/sets",
    })
  }
  return out
}

// ── Candy MLB ─────────────────────────────────────────────────────────────────────────
export const CANDY_FEED_URL = "https://blog.candy.io/rss/"
const CANDY_DROP_TITLE = /\b(drops?|packs?|icons?|series)\b/i
const CANDY_NOT_A_DROP = /\b(wallet|community update|questions|connect|buyback)\b/i

/** Drop-titled posts from Candy's RSS published in the last `daysBack` days. */
export function parseCandyAnnouncements(xml: string, now: Date, daysBack = 7): PackCalendarAnnouncement[] {
  const out: PackCalendarAnnouncement[] = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1]
    const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? "").trim()
    const link = (it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "").trim()
    const pub = Date.parse(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "")
    if (!title || !/^https:\/\/blog\.candy\.io\//.test(link) || !Number.isFinite(pub)) continue
    if (pub < now.getTime() - daysBack * DAY_MS || pub > now.getTime() + DAY_MS) continue
    if (!CANDY_DROP_TITLE.test(title) || CANDY_NOT_A_DROP.test(title)) continue
    out.push({ collection: "candy_mlb", title, url: link, published_at: new Date(pub).toISOString() })
  }
  return out.sort((a, b) => b.published_at.localeCompare(a.published_at))
}

async function readCandy(fetchImpl: typeof fetch, now: Date): Promise<{ ok: boolean; announcements: PackCalendarAnnouncement[] }> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 6000)
    const r = await fetchImpl(CANDY_FEED_URL, { signal: ctl.signal, headers: { "user-agent": "RipPacksCity/1.0 (www.rippackscity.com)" } })
    clearTimeout(t)
    if (!r.ok) return { ok: false, announcements: [] }
    const xml = await r.text()
    // A feed with no <item> at all is not Candy's blog answering — treat it as unread.
    if (!/<item>/.test(xml)) return { ok: false, announcements: [] }
    return { ok: true, announcements: parseCandyAnnouncements(xml, now) }
  } catch {
    return { ok: false, announcements: [] }
  }
}

// ── Delivered pre-orders / draws ──────────────────────────────────────────────────────
// A pre-order (Top Shot) or timed draw (Pinnacle) is OVER once its packs are being OPENED: only
// collectors who were delivered a pack can open one. Atlas's end_time does not say so — for
// Pinnacle it is the leftover WAITING ROOM's end (Stitch in Costume Vol.1: requests closed 11-06
// 9 AM PT and it sold out, yet end_time read 11-13; verified on disneypinnacle.com/releases
// 2026-11-08). ⛔ NOT pack MINTS: Pinnacle mints a release's whole supply when it OPENS
// (Stitch / Villains Vol.2: 614 PackNFT.Minted on 10-30 18:59 UTC, the first hour of the draw), so
// "minted" would end every draw on its first day.
//   Top Shot: pack_rips (opens) for the dist.   Pinnacle: pinnacle_pack_opens for the dist.
const TOP_SHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function firstOpen(sb: any, d: PackCalendarDrop): Promise<{ any: boolean; at: string | null }> {
  if (d.collection === "disney_pinnacle") {
    const { data, error } = await sb
      .from("pinnacle_pack_opens")
      .select("opened_at")
      .eq("dist_id", d.dist_id)
      .order("opened_at", { ascending: true })
      .limit(1)
    if (error) throw new Error(`pinnacle_pack_opens(${d.dist_id}): ${error.message}`)
    const at = (data ?? [])[0]?.opened_at ?? null
    return { any: (data ?? []).length > 0, at }
  }
  if (d.collection === "nba_top_shot") {
    const { data, error } = await sb.from("pack_rips").select("dist_id").eq("collection_id", TOP_SHOT_UUID).eq("dist_id", d.dist_id).limit(1)
    if (error) throw new Error(`pack_rips(${d.dist_id}): ${error.message}`)
    return { any: (data ?? []).length > 0, at: null }
  }
  return { any: false, at: null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markDeliveredDraws(sb: any, drops: PackCalendarDrop[]): Promise<void> {
  for (const d of drops) {
    if (d.kind !== "rsvp" || d.status !== "open") continue
    const o = await firstOpen(sb, d)
    if (!o.any) continue
    d.status = "ended"
    // Pinnacle: the first open is when it was demonstrably over. Top Shot: keep Dapper's own close.
    if (o.at) d.end_time = new Date(o.at).toISOString()
  }
}

// Top Shot and All Day are always expected; a missing state row for them is an unread book.
const REQUIRED: PackCalendarProduct[] = ["nba", "nfl"]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchPackCalendar(sb: any, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<PackCalendarResult> {
  const { data: state, error: stateErr } = await sb
    .from("atlas_pack_market_state")
    .select("product, last_complete_pass_started_at, last_complete_at")
  if (stateErr) throw new Error(`atlas_pack_market_state: ${stateErr.message}`)

  const walked = new Set<PackCalendarProduct>(REQUIRED)
  for (const s of (state ?? []) as { product: string }[]) if (isProduct(s.product)) walked.add(s.product)

  const complete_at: Partial<Record<PackCalendarSource, string | null>> = {}
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
  const drops = buildPackCalendar(rows, now)

  // Panini: read only while the runner keeps the table fresh; a stale table is UNREAD.
  const since = new Date(now.getTime() - 60 * DAY_MS).toISOString()
  const { data: pRows, error: pErr } = await sb
    .from("panini_pack_drops")
    .select("pack_id, name, sport, price_usd, cards_per_pack, start_at, end_at, in_stock, is_available, last_seen_at")
    .gte("start_at", since)
    .order("start_at", { ascending: true })
    .limit(1000)
  if (pErr) throw new Error(`panini_pack_drops: ${pErr.message}`)
  const paniniRows = (pRows ?? []) as PaniniDropSourceRow[]
  const newestSeen = paniniRows.reduce((m, r) => (r.last_seen_at > m ? r.last_seen_at : m), "")
  if (newestSeen && now.getTime() - Date.parse(newestSeen) <= PANINI_FRESH_HOURS * 3_600_000) {
    complete_at.panini = newestSeen
    drops.push(...buildPaniniDrops(paniniRows, now))
  } else {
    complete_at.panini = null
    complete = false
  }

  // Pinnacle Open Editions: unread unless the mint lane is at the chain head.
  const { data: oe, error: oeErr } = await sb.rpc("get_pinnacle_open_edition_drops", { p_days: 14 })
  if (oeErr) throw new Error(`get_pinnacle_open_edition_drops: ${oeErr.message}`)
  const oeAsOf = oe && typeof oe === "object" && typeof oe.lane_as_of === "string" ? oe.lane_as_of : null
  if (oeAsOf && Array.isArray(oe.sets)) {
    complete_at.pinnacle_oe = oeAsOf
    drops.push(...buildPinnacleOpenEditionDrops(oe.sets as PinnacleOpenEditionSet[], now))
  } else {
    complete_at.pinnacle_oe = null
    complete = false
  }

  const candy = await readCandy(fetchImpl, now)
  complete_at.candy = candy.ok ? now.toISOString() : null
  if (!candy.ok) complete = false

  await markDeliveredDraws(sb, drops)

  drops.sort((a, b) => a.start_time.localeCompare(b.start_time) || a.dist_id.localeCompare(b.dist_id))
  return { complete, complete_at, drops, announcements: candy.announcements }
}
