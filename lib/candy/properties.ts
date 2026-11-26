// lib/candy/properties.ts
//
// Candy LEAGUES AND BRANDS (2026-11-26): Candy publishes MLB, but also DC, NASCAR, WWE, Netflix, Getty Images
// and more. Each Candy collection carries the publisher's own brand code in its official metadata
// (candy_collections.brand_symbol, migration 20261126201206); migration 20261126201654 maps that to a row of
// public.publisher_properties. ⛔ Collectors never see the word "property": on screen these sit under
// "Leagues" and "Entertainment" (Trevor 11-26). "property" is for URLs, code and docs.
//
// HONESTY: `{ ok:false }` = the read failed (callers render nothing or say so — never an empty grid stated
// as fact). `cards` is cards in circulation per the chain; `editions` is distinct cards RPC has catalogued;
// sales are those on record. A collection with no brand code is counted as unplaced, never guessed.

import { cache } from "react"
import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import type { CandySetBrandIndex } from "@/lib/candy/brand-groups"

export type CandyPropertyHeading = "leagues" | "entertainment"

export const CANDY_PROPERTY_HEADINGS: { key: CandyPropertyHeading; label: string }[] = [
  { key: "leagues", label: "Leagues" },
  { key: "entertainment", label: "Entertainment" },
]

export interface CandyProperty {
  slug: string
  name: string
  heading: CandyPropertyHeading
  category: string
  subject_word: string
  team_league: string | null
  sort_order: number
  collections: number
  cards: number
  editions: number
  priced_editions: number
  listed_editions: number
  sales_90d: number
  /** null when no sale is on record (never $0). */
  sales_90d_volume_usd: number | null
  first_season: string | null
  last_season: string | null
}

export interface CandyPropertyBoard {
  properties: CandyProperty[]
  /** set page slug → property slug; a slug two brands share is left out, never guessed. */
  setProperty: Record<string, string>
  unplacedCollections: number
}

export type CandyPropertyBoardRead = { ok: true; board: CandyPropertyBoard } | { ok: false; board: null }

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v.filter((x) => rec(x)) as Record<string, unknown>[]) : [])
const headingOf = (v: unknown): CandyPropertyHeading | null => (v === "leagues" || v === "entertainment" ? v : null)

/** Pure parse of the RPC's jsonb; null = not the expected shape (a failed read, not an empty board). */
export function toCandyPropertyBoard(data: unknown): CandyPropertyBoard | null {
  const d = rec(data)
  if (!d || !Array.isArray(d.properties)) return null
  const properties: CandyProperty[] = []
  for (const raw of list(d.properties)) {
    const slug = str(raw.slug)
    const name = str(raw.name)
    const heading = headingOf(raw.heading)
    if (!slug || !name || !heading) continue
    properties.push({
      slug,
      name,
      heading,
      category: str(raw.category) ?? "",
      subject_word: str(raw.subject_word) ?? "player",
      team_league: str(raw.team_league),
      sort_order: num(raw.sort_order) ?? 1000,
      collections: num(raw.collections) ?? 0,
      cards: num(raw.cards) ?? 0,
      editions: num(raw.editions) ?? 0,
      priced_editions: num(raw.priced_editions) ?? 0,
      listed_editions: num(raw.listed_editions) ?? 0,
      sales_90d: num(raw.sales_90d) ?? 0,
      sales_90d_volume_usd: num(raw.sales_90d_volume_usd),
      first_season: str(raw.first_season),
      last_season: str(raw.last_season),
    })
  }
  const setProperty: Record<string, string> = {}
  const sp = rec(d.set_property)
  if (sp) for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) setProperty[k] = v
  return { properties, setProperty, unplacedCollections: num(d.unplaced_collections) ?? 0 }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCandyPropertyBoard(db: any = supabaseAdmin): Promise<CandyPropertyBoardRead> {
  try {
    const { data, error } = await withQueryDeadline<unknown>(db.rpc("get_candy_property_board"), "candy/property-board", apiReadTimeoutMs())
    if (error) return { ok: false, board: null }
    const board = toCandyPropertyBoard(data)
    return board ? { ok: true, board } : { ok: false, board: null }
  } catch {
    return { ok: false, board: null }
  }
}

/** One read per request, shared by the overview grid, the coverage map and a set page's breadcrumb. */
export const fetchCandyPropertyBoard = cache(() => readCandyPropertyBoard())

export function candyPropertyHref(collection: string, slug: string): string {
  return `/${collection}/property/${encodeURIComponent(slug)}`
}

/** "2021 to 2026", or the single year; null when no collection name carries one. */
export function candySeasonSpan(p: { first_season: string | null; last_season: string | null }): string | null {
  if (!p.first_season && !p.last_season) return null
  if (!p.first_season || !p.last_season || p.first_season === p.last_season) return p.last_season ?? p.first_season
  return `${p.first_season} to ${p.last_season}`
}

// ── The page per league / brand ─────────────────────────────────────────────────────────────────────────

export interface CandyPropertyCollection {
  name: string
  /** Display grouping inside a big brand ("Comics", "ICONs" …); null for a brand shown as one list. */
  program: string | null
  season: string | null
  /** null when RPC has catalogued no card of it yet — then there is no set page to link. */
  set_slug: string | null
  cards: number
  editions: number
  priced_editions: number
  listed_editions: number
  sales_90d: number
  sales_90d_volume_usd: number | null
  newest_sale_at: string | null
}

export interface CandyPropertyEdition {
  external_id: string
  name: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  fmv_usd: number
}

export interface CandyPropertySale {
  external_id: string
  name: string | null
  player_name: string | null
  set_name: string | null
  serial_number: number | null
  price_usd: number
  sold_at: string
}

export interface CandyPropertySubject {
  player_name: string
  editions: number
  priced_editions: number
}

export interface CandyPropertyPage {
  slug: string
  name: string
  heading: CandyPropertyHeading
  category: string
  subject_word: string
  team_league: string | null
  computed_at: string | null
  collections: CandyPropertyCollection[]
  cards: number
  editions: number
  priced_editions: number
  listed_editions: number
  sales_90d: number
  sales_90d_volume_usd: number | null
  newest_sale_at: string | null
  first_season: string | null
  last_season: string | null
  top_editions: CandyPropertyEdition[]
  top_sales_90d: CandyPropertySale[]
  top_subjects: CandyPropertySubject[]
}

/** ok:false = the read failed; ok:true + null = no such league / brand, or one with no collection (404). */
export type CandyPropertyPageRead = { ok: true; page: CandyPropertyPage | null } | { ok: false; page: null }

/** Pure parse; `undefined` = not the expected shape (a failed read). */
export function toCandyPropertyPage(data: unknown): CandyPropertyPage | null | undefined {
  if (data === null || data === undefined) return null
  const d = rec(data)
  const prop = rec(d?.property)
  const totals = rec(d?.totals)
  if (!d || !prop || !totals || !Array.isArray(d.collections)) return undefined
  const slug = str(prop.slug)
  const name = str(prop.name)
  const heading = headingOf(prop.heading)
  if (!slug || !name || !heading) return undefined
  const collections: CandyPropertyCollection[] = []
  for (const r of list(d.collections)) {
    const n = str(r.name)
    if (!n) continue
    const editions = num(r.editions) ?? 0
    collections.push({
      name: n,
      program: str(r.program),
      season: str(r.season),
      set_slug: editions > 0 ? str(r.set_slug) : null,
      cards: num(r.cards) ?? 0,
      editions,
      priced_editions: num(r.priced_editions) ?? 0,
      listed_editions: num(r.listed_editions) ?? 0,
      sales_90d: num(r.sales_90d) ?? 0,
      sales_90d_volume_usd: num(r.sales_90d_volume_usd),
      newest_sale_at: str(r.newest_sale_at),
    })
  }
  if (collections.length === 0) return null
  const top_editions: CandyPropertyEdition[] = []
  for (const r of list(d.top_editions)) {
    const id = str(r.external_id)
    const fmv = num(r.fmv_usd)
    if (!id || fmv === null) continue
    top_editions.push({ external_id: id, name: str(r.name), player_name: str(r.player_name), set_name: str(r.set_name), tier: str(r.tier), circulation_count: num(r.circulation_count), fmv_usd: fmv })
  }
  const top_sales_90d: CandyPropertySale[] = []
  for (const r of list(d.top_sales_90d)) {
    const id = str(r.external_id)
    const price = num(r.price_usd)
    const at = str(r.sold_at)
    if (!id || price === null || !at) continue
    top_sales_90d.push({ external_id: id, name: str(r.name), player_name: str(r.player_name), set_name: str(r.set_name), serial_number: num(r.serial_number), price_usd: price, sold_at: at })
  }
  const top_subjects: CandyPropertySubject[] = []
  for (const r of list(d.top_subjects)) {
    const pn = str(r.player_name)
    if (!pn) continue
    top_subjects.push({ player_name: pn, editions: num(r.editions) ?? 0, priced_editions: num(r.priced_editions) ?? 0 })
  }
  return {
    slug,
    name,
    heading,
    category: str(prop.category) ?? "",
    subject_word: str(prop.subject_word) ?? "player",
    team_league: str(prop.team_league),
    computed_at: str(d.computed_at),
    collections,
    cards: num(totals.cards) ?? 0,
    editions: num(totals.editions) ?? 0,
    priced_editions: num(totals.priced_editions) ?? 0,
    listed_editions: num(totals.listed_editions) ?? 0,
    sales_90d: num(totals.sales_90d) ?? 0,
    sales_90d_volume_usd: num(totals.sales_90d_volume_usd),
    newest_sale_at: str(totals.newest_sale_at),
    first_season: str(totals.first_season),
    last_season: str(totals.last_season),
    top_editions,
    top_sales_90d,
    top_subjects,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCandyPropertyPage(slug: string, db: any = supabaseAdmin): Promise<CandyPropertyPageRead> {
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("get_candy_property_page", { p_slug: slug, p_limit: 12 }),
      "candy/property-page",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, page: null }
    const page = toCandyPropertyPage(data)
    return page === undefined ? { ok: false, page: null } : { ok: true, page }
  } catch {
    return { ok: false, page: null }
  }
}

/** Shared by the segment layout, generateMetadata and the page: one read per request. */
export const fetchCandyPropertyPage = cache((slug: string) => readCandyPropertyPage(slug))

/** Collections grouped for display: programs in a fixed, sensible order; a brand with no programs is one group. */
export function groupCandyCollections(collections: CandyPropertyCollection[]): { program: string | null; rows: CandyPropertyCollection[] }[] {
  const by = new Map<string, CandyPropertyCollection[]>()
  for (const c of collections) {
    const k = c.program ?? ""
    const rows = by.get(k)
    if (rows) rows.push(c)
    else by.set(k, [c])
  }
  const volume = (rows: CandyPropertyCollection[]) => rows.reduce((s, r) => s + (r.sales_90d_volume_usd ?? 0), 0)
  const tail = (k: string) => (/^(More from|Rewards and)/.test(k) ? 1 : 0)
  return [...by.entries()]
    .sort((a, b) => tail(a[0]) - tail(b[0]) || volume(b[1]) - volume(a[1]) || a[0].localeCompare(b[0]))
    // Natural order inside a line, so "#2" sits before "#10" and a title's issues read in sequence.
    .map(([k, rows]) => ({ program: k || null, rows: [...rows].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })) }))
}

// ── A set page's way back to its league / brand ─────────────────────────────────────────────────────────

export type CandySetPropertyRead = { ok: true; property: { slug: string; name: string } | null } | { ok: false; property: null }

/**
 * The league / brand a Candy collection (= a set page) belongs to, for its breadcrumb. Two small reads, not
 * the whole board. A name two brands share ("2023 Tickets": MLB and NASCAR) resolves to null — the crumb is
 * left out rather than guessed; so is a failed read (ok:false), which the caller treats the same way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCandySetProperty(setName: string, db: any = supabaseAdmin): Promise<CandySetPropertyRead> {
  try {
    const cols = await withQueryDeadline<unknown>(
      db.from("candy_collections").select("property_slug").eq("name", setName).neq("kind", "test").limit(10),
      "candy/set-property",
      apiReadTimeoutMs(),
    )
    if (cols.error || !Array.isArray(cols.data)) return { ok: false, property: null }
    const slugs = new Set<string>()
    for (const r of cols.data as Array<{ property_slug?: unknown }>) if (typeof r?.property_slug === "string" && r.property_slug) slugs.add(r.property_slug)
    if (slugs.size !== 1) return { ok: true, property: null }
    const slug = [...slugs][0]
    const prop = await withQueryDeadline<unknown>(
      db.from("publisher_properties").select("slug,name").eq("publisher", "candy").eq("slug", slug).limit(1),
      "candy/set-property-name",
      apiReadTimeoutMs(),
    )
    if (prop.error || !Array.isArray(prop.data)) return { ok: false, property: null }
    const row = prop.data[0] as { slug?: unknown; name?: unknown } | undefined
    return typeof row?.slug === "string" && typeof row?.name === "string" ? { ok: true, property: { slug: row.slug, name: row.name } } : { ok: true, property: null }
  } catch {
    return { ok: false, property: null }
  }
}

export const fetchCandySetProperty = cache((setName: string) => readCandySetProperty(setName))

// ── Brand of every Candy set, by set id (the Candy squeeze picker groups its sets by it) ───────────────

/** Two small reads. null = a read failed — the caller then shows its list ungrouped, never a guessed brand. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readCandySetBrandIndex(db: any = supabaseAdmin): Promise<CandySetBrandIndex | null> {
  try {
    const [cols, props] = await Promise.all([
      withQueryDeadline<unknown>(
        db.from("candy_collections").select("set_id,property_slug").not("property_slug", "is", null).not("set_id", "is", null).order("address", { ascending: true }).limit(1000),
        "candy/set-brand-index",
        apiReadTimeoutMs(),
      ),
      withQueryDeadline<unknown>(
        db.from("publisher_properties").select("slug,name,sort_order").eq("publisher", "candy").order("sort_order", { ascending: true }).limit(200),
        "candy/set-brand-names",
        apiReadTimeoutMs(),
      ),
    ])
    if (cols.error || props.error || !Array.isArray(cols.data) || !Array.isArray(props.data) || cols.data.length >= 1000) return null
    const names: Record<string, string> = {}
    const order: string[] = []
    for (const r of props.data as Array<{ slug?: unknown; name?: unknown }>) {
      if (typeof r?.slug === "string" && typeof r?.name === "string") { names[r.slug] = r.name; order.push(r.slug) }
    }
    const bySetId: Record<string, string> = {}
    for (const r of cols.data as Array<{ set_id?: unknown; property_slug?: unknown }>) {
      if (typeof r?.set_id === "string" && typeof r?.property_slug === "string" && names[r.property_slug]) bySetId[r.set_id] = r.property_slug
    }
    return { bySetId, names, order }
  } catch {
    return null
  }
}

export const fetchCandySetBrandIndex = cache(() => readCandySetBrandIndex())
