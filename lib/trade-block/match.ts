// lib/trade-block/match.ts
//
// The Trade Block matcher (2026-11-02, v2 of docs/strategy/features/trading.md §3). For a
// signed-in collector it answers two questions over the open listings:
//   · THEY WANT WHAT YOU HOLD — a listing's wants (an edition, or any asset of a player /
//     character) that an asset in one of YOUR PROVEN accounts satisfies;
//   · THEY OFFER WHAT YOU WANT — a listing's offered assets that one of YOUR open
//     listings' wants names.
// A listing that does both is a TWO-WAY match: each side has something the other asked
// for, so a proposal is nearly written already.
//
// Only proven accounts are matched (the same ownership rule as posting), only open,
// unexpired listings, never the caller's own. Matching is by catalog key for an edition
// want and by a case- and accent-blind name for a player / character want, always within
// one collection (a moment_id or a name means nothing across collections).
//
// Honesty: every read throws on failure — the route answers 503, never "no matches". The
// population is bounded (MATCH_POPULATION_LIMIT newest listings); `complete: false` says
// so instead of presenting a partial scan as the whole block.

import type { SupabaseClient } from "@supabase/supabase-js"
import { foldForMatch } from "@/lib/filter-match"
import { accentInsensitiveRegex } from "@/lib/search/accent-regex"
import { collectionById } from "@/lib/trade-block/rules"
import {
  allOpenListings,
  provenAccounts,
  toHolding,
  type Holding,
  type ItemRow,
  type LoadedListing,
} from "@/lib/trade-block/store"

/** A want, reduced to what can be compared. */
export interface WantKey {
  collection_id: string
  kind: "edition" | "player"
  /** edition_key for an edition want; the folded name for a player want */
  key: string
}

export function foldName(s: string | null | undefined): string {
  return foldForMatch(String(s ?? "")).replace(/\s+/g, " ").trim()
}

export function wantKeys(items: readonly ItemRow[]): WantKey[] {
  const out: WantKey[] = []
  for (const i of items) {
    if (i.role !== "want") continue
    if (i.kind === "edition" && i.edition_key) out.push({ collection_id: i.collection_id, kind: "edition", key: i.edition_key })
    else if (i.kind === "player" && i.player_name) out.push({ collection_id: i.collection_id, kind: "player", key: foldName(i.player_name) })
  }
  return out
}

/** Does an asset (a holding, or an offered line) satisfy a want? */
export function satisfies(
  w: WantKey,
  a: { collection_id: string; edition_key: string | null; player_name: string | null },
): boolean {
  if (a.collection_id !== w.collection_id) return false
  if (w.kind === "edition") return a.edition_key === w.key
  return a.player_name != null && foldName(a.player_name) === w.key
}

export interface Match {
  listing: LoadedListing
  /** Your assets that satisfy this listing's wants (your own accounts; never published). */
  you_hold: Holding[]
  /** This listing's offered lines that your open listings want. */
  they_offer: ItemRow[]
  two_way: boolean
}

export interface MatchResult {
  /** False when the caller has proved no account — "you hold" cannot be answered. */
  proven: boolean
  /** How many wants the caller's own open listings carry. */
  my_wants: number
  matches: Match[]
  /** False when the open population exceeded the scan bound. */
  complete: boolean
}

/** Pure: rank and assemble matches from already-read data. */
export function assembleMatches(
  others: readonly LoadedListing[],
  myWants: readonly WantKey[],
  holdings: readonly Holding[],
  perListing = 5,
): Match[] {
  const out: Match[] = []
  for (const l of others) {
    const theirWants = wantKeys(l.items)
    const youHold: Holding[] = []
    const seen = new Set<string>()
    for (const w of theirWants) {
      for (const h of holdings) {
        const k = `${h.collection_id}:${h.moment_id}`
        if (!seen.has(k) && satisfies(w, h)) {
          seen.add(k)
          youHold.push(h)
        }
      }
    }
    const theyOffer = l.items.filter((i) => i.role === "offer" && myWants.some((w) => satisfies(w, i)))
    if (youHold.length === 0 && theyOffer.length === 0) continue
    out.push({ listing: l, you_hold: youHold.slice(0, perListing), they_offer: theyOffer.slice(0, perListing), two_way: youHold.length > 0 && theyOffer.length > 0 })
  }
  return out.sort(
    (a, b) =>
      Number(b.two_way) - Number(a.two_way) ||
      b.you_hold.length + b.they_offer.length - (a.you_hold.length + a.they_offer.length) ||
      b.listing.listing.created_at.localeCompare(a.listing.listing.created_at),
  )
}

function fail(error: { message: string } | null, what: string): never {
  throw new Error(`${what}: ${error?.message ?? "no rows returned"}`)
}

const HOLDING_COLS =
  "wallet_address, collection_id, moment_id, edition_key, player_name, character_name, set_name, tier, series_number, serial_number, image_url, fmv_usd, fmv_confidence, is_locked"
/** Distinct player / character wants looked up per call (each is one bounded read). */
export const MAX_PLAYER_LOOKUPS = 30
const PER_LOOKUP = 20

/**
 * The caller's assets that could satisfy any of `wants`: by edition key (chunked `in`),
 * and by name per player want (accent-blind compare after the read). Bounded; throws on
 * any failed read.
 */
export async function holdingsForWants(
  db: SupabaseClient,
  sources: readonly string[],
  wants: readonly WantKey[],
  /** Set to `truncated: true` when a bounded read hit its cap or player wants were dropped (2026-11-07 review). */
  meta: { truncated: boolean } = { truncated: false },
): Promise<Holding[]> {
  if (sources.length === 0 || wants.length === 0) return []
  const out = new Map<string, Holding>()
  const add = (rows: unknown[]) => {
    for (const r of rows as Parameters<typeof toHolding>[0][]) {
      const h = toHolding(r)
      // a locked asset can't be traded, so it doesn't make a match (2026-11-04)
      if (h.locked) continue
      out.set(`${h.collection_id}:${h.moment_id}`, h)
    }
  }
  // editions: group by collection, chunk the keys
  const byCollection = new Map<string, Set<string>>()
  for (const w of wants) if (w.kind === "edition") (byCollection.get(w.collection_id) ?? byCollection.set(w.collection_id, new Set()).get(w.collection_id)!).add(w.key)
  const reads: Array<PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>> = []
  for (const [collection, keys] of byCollection) {
    const list = [...keys]
    for (let i = 0; i < list.length; i += 100) {
      reads.push(
        db
          .from("wallet_moments_cache")
          .select(HOLDING_COLS)
          .in("wallet_address", [...sources])
          .eq("collection_id", collection)
          .in("edition_key", list.slice(i, i + 100))
          .order("moment_id")
          .limit(PER_LOOKUP * 10) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
      )
    }
  }
  // players / characters: one bounded read each (names are typed by people, so the
  // compare happens after the read, accent- and case-blind)
  const players = new Map<string, WantKey>()
  for (const w of wants) if (w.kind === "player") players.set(`${w.collection_id}|${w.key}`, w)
  const playerWants = [...players.values()].slice(0, MAX_PLAYER_LOOKUPS)
  if (players.size > MAX_PLAYER_LOOKUPS) meta.truncated = true
  for (const w of playerWants) {
    const term = w.key.split(" ").filter((t) => t.length >= 3).sort((a, b) => b.length - a.length)[0] ?? w.key
    const safe = term.replace(/[%_\\,()"]/g, "")
    if (!safe) continue
    // Pinnacle: the CHARACTER, never the pin's name; elsewhere the player
    const col = collectionById(w.collection_id)?.person === "character" ? "character_name" : "player_name"
    const rx = accentInsensitiveRegex(safe)
    let q = db.from("wallet_moments_cache").select(HOLDING_COLS).in("wallet_address", [...sources]).eq("collection_id", w.collection_id)
    q = rx ? q.filter(col, "imatch", rx) : q.ilike(col, `%${safe}%`)
    reads.push(q.order("moment_id").limit(PER_LOOKUP * 10) as unknown as PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>)
  }
  const results = await Promise.all(reads)
  for (const { data, error } of results) {
    if (error) fail(error, "wallet_moments_cache match read")
    // a read that came back AT its cap may have more rows behind it
    if ((data?.length ?? 0) >= PER_LOOKUP * 10) meta.truncated = true
    add(data ?? [])
  }
  return [...out.values()].filter((h) => wants.some((w) => satisfies(w, h)))
}

export async function findMatches(db: SupabaseClient, userId: string, now: number = Date.now()): Promise<MatchResult> {
  const [accounts, population] = await Promise.all([provenAccounts(db, userId), allOpenListings(db, now)])
  const mine = population.listings.filter((l) => l.listing.user_id === userId)
  const others = population.listings.filter((l) => l.listing.user_id !== userId)
  const myWants = mine.flatMap((l) => wantKeys(l.items))
  const theirWants = others.flatMap((l) => wantKeys(l.items))
  const meta = { truncated: false }
  const holdings = accounts.length ? await holdingsForWants(db, accounts.map((a) => a.source), theirWants, meta) : []
  return {
    proven: accounts.length > 0,
    my_wants: myWants.length,
    matches: assembleMatches(others, myWants, holdings),
    // ⚠ complete only when BOTH the listing population AND the holdings reads were
    // whole — a 31st player want, or a capped read, left matches unchecked while
    // the answer said complete:true, so a missing match read as "no match".
    complete: population.complete && !meta.truncated,
  }
}
