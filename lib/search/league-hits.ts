// lib/search/league-hits.ts
//
// Site search answers a LEAGUE or BRAND (2026-11-26): "dc", "nascar", "world cup", "wnba" lead the results
// with the page for it — Panini's or Candy's (/…/property/<slug>). Until now those words only matched
// players, sets and teams, so "dc" found nothing that said "DC lives here".
//
// The index is tiny and changes when a publisher adds a brand, so it is read once an hour per instance:
// Panini from get_panini_property_board (only leagues with a product page — any other slug 404s) and Candy
// from candy_collections.property_slug. HONESTY: a failed read adds NO hits and is not cached (retried after
// a minute); it never fails the search and never answers "no such league".

import { boundedRead } from "@/lib/api/bounded-read"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import type { SearchResultWithSlug } from "@/lib/search/player-hub-hits"

export interface LeagueIndexRow {
  publisher: "panini" | "candy"
  slug: string
  name: string
  heading: "leagues" | "entertainment"
}

const TTL_MS = 60 * 60 * 1000
const READ_BUDGET_MS = 2_000
const FAILURE_BACKOFF_MS = 60_000
const MAX_HITS = 3
const URL_SLUG = { panini: "panini-blockchain", candy: "candy-mlb" } as const

let memo: { at: number; rows: LeagueIndexRow[] } | null = null
let failedAt = 0

/** Test seam: forget the memo and the failure backoff. */
export function resetLeagueIndexForTests(): void {
  memo = null
  failedAt = 0
}

const headingOf = (v: unknown): LeagueIndexRow["heading"] | null => (v === "leagues" || v === "entertainment" ? v : null)

/** The league / brand index, memoized for an hour. A failed read returns [] and is NOT cached. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadLeagueIndex(db: any): Promise<LeagueIndexRow[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.rows
  if (Date.now() - failedAt < FAILURE_BACKOFF_MS) return []
  try {
    const [panini, props, candy] = await Promise.all([
      boundedRead(db.rpc("get_panini_property_board", {}), "search/league-index-panini", READ_BUDGET_MS),
      boundedRead(db.from("publisher_properties").select("slug,name,heading").eq("publisher", "candy").order("sort_order", { ascending: true }).limit(200), "search/league-index-candy-names", READ_BUDGET_MS),
      boundedRead(db.from("candy_collections").select("property_slug").not("property_slug", "is", null).neq("kind", "test").order("address", { ascending: true }).limit(1000), "search/league-index-candy", READ_BUDGET_MS),
    ])
    const board = (panini.data as { properties?: unknown } | null)?.properties
    if (panini.error || props.error || candy.error || !Array.isArray(board) || !Array.isArray(props.data) || !Array.isArray(candy.data)) {
      failedAt = Date.now()
      console.error("[search] league index unavailable — no league / brand hits")
      return []
    }
    const rows: LeagueIndexRow[] = []
    for (const r of board as Array<Record<string, unknown>>) {
      const heading = headingOf(r?.heading)
      if (typeof r?.slug === "string" && typeof r?.name === "string" && heading) rows.push({ publisher: "panini", slug: r.slug, name: r.name, heading })
    }
    const live = new Set((candy.data as Array<{ property_slug?: unknown }>).map((r) => r.property_slug).filter((s): s is string => typeof s === "string"))
    for (const r of props.data as Array<Record<string, unknown>>) {
      const heading = headingOf(r?.heading)
      if (typeof r?.slug === "string" && typeof r?.name === "string" && heading && live.has(r.slug)) rows.push({ publisher: "candy", slug: r.slug, name: r.name, heading })
    }
    memo = { at: Date.now(), rows }
    return rows
  } catch {
    failedAt = Date.now()
    return []
  }
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

/**
 * League / brand rows for a query: the whole name, or a leading run of its words, starts with the query
 * ("world c" → FIFA World Cup; "dc" → DC; "nba" → NBA, not WNBA). `collectionUrlSlug` keeps a scoped search
 * to that publisher. Exact name matches lead.
 */
export function leagueHits(q: string, index: LeagueIndexRow[], collectionUrlSlug: string | null): SearchResultWithSlug[] {
  const needle = fold(q)
  if (needle.length < 2) return []
  const scored: Array<{ rank: number; row: LeagueIndexRow }> = []
  for (const row of index) {
    if (collectionUrlSlug && URL_SLUG[row.publisher] !== collectionUrlSlug) continue
    const name = fold(row.name)
    const words = name.split(" ")
    const starts = words.some((_, i) => words.slice(i).join(" ").startsWith(needle))
    if (!starts) continue
    scored.push({ rank: name === needle ? 0 : name.startsWith(needle) ? 1 : 2, row })
  }
  scored.sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name) || a.row.publisher.localeCompare(b.row.publisher))
  const out: SearchResultWithSlug[] = []
  for (const { row } of scored.slice(0, MAX_HITS)) {
    const coll = getCollectionByUrlSlug(URL_SLUG[row.publisher])
    if (!coll) continue
    out.push({
      kind: row.heading === "entertainment" ? "brand" : "league",
      label: row.name,
      sublabel: row.publisher === "panini" ? "Every Panini product and card" : "Every Candy collection and card",
      href: `/${coll.urlSlug}/property/${encodeURIComponent(row.slug)}`,
      collection: coll.urlSlug,
      collectionName: coll.displayName,
      thumbnailUrl: null,
      editionCount: null,
      slug: row.slug,
      collectionId: coll.id,
    })
  }
  return out
}
