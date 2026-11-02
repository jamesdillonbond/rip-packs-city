// lib/trade-room/holdings.ts
//
// What a trade-room side can pick from: the moments RPC has indexed for the account
// its moments sit in, ONE collection at a time (NBA Top Shot, NFL All Day, LaLiga
// Golazos or UFC Strike since 2026-11-02; wallet_moments_cache scoped by collection_id, see CLAUDE.md
// "a moment_id is unique only within a collection"). This is the PICKER, not the truth: before a pick is saved the chain
// is read for "held and unlocked" (lib/trade-room/execute.ts), and again before any
// wallet signs. A wallet RPC has not indexed yet is reported as such (indexed:
// false), never as "holds nothing".
//
// The FMV shown beside a moment is RPC's, and only when its confidence was HIGH or
// MEDIUM; otherwise the moment is "not priced". The tier itself never leaves the
// server (FMV confidence is internal, 2026-10-18).

import type { SupabaseClient } from "@supabase/supabase-js"
import { retryEmptyWithAccentRegex } from "@/lib/search/accent-regex"
import type { ItemCollection, NewItem } from "@/lib/trade-room/store"
import { swapCollection, type SwapSlug } from "@/lib/trade-room/multi-swap-cadence"
import type { Holding } from "@/lib/giveaways/topshot-holdings"

export const TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const CONFIDENT = new Set(["HIGH", "MEDIUM"])
export const PICKER_LIMIT = 500

export interface PickerRow extends NewItem {
  /** Lock state: read from the chain just now when the result's lock_state is "live", else RPC's last
   *  cached read (may be stale; the chain is re-read on save either way). */
  locked_hint: boolean | null
  /** "live" results only: false when the chain says this account no longer holds the moment. */
  held_live?: boolean
  /** True when fmv_usd is a confident price (the only case it is non-null). */
  priced: boolean
}

export interface PickerResult {
  /** False when RPC holds no rows for this account at all. */
  indexed: boolean
  rows: PickerRow[]
  /** True when more than PICKER_LIMIT rows exist (the picker shows the first page). */
  truncated: boolean
  /** "live": locked_hint/held_live were read from the chain for these rows; "cached": the chain read
   *  failed or ran out of time, so locked_hint is RPC's last check (#222). Absent = not attempted. */
  lock_state?: "live" | "cached"
  /** Chain-driven pickers (All Day / Golazos / UFC): how many Moments the chain says the account
   *  holds that RPC has not indexed yet (they can't be picked until it has). Absent = not measured. */
  unindexed_held?: number
  /** Chain-driven pickers: the account has no collection of this kind at all. */
  no_collection?: boolean
  /** Chain-driven pickers: Moments RPC lists for this account that are NOT in its on-chain
   *  collection right now (locked, held by Dapper's studio, or moved) — they can't be traded. */
  not_in_collection?: number
}

type WmcRow = {
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  image_url: string | null
  fmv_usd: number | string | null
  fmv_confidence: string | null
  is_locked: boolean | null
}

export function toPickerRow(w: WmcRow, collection: ItemCollection = "nba_top_shot"): PickerRow {
  const conf = String(w.fmv_confidence ?? "").toUpperCase()
  const fmv = w.fmv_usd == null ? null : Number(w.fmv_usd)
  const priced = CONFIDENT.has(conf) && fmv != null && Number.isFinite(fmv) && fmv >= 0
  return {
    collection,
    moment_id: String(w.moment_id),
    edition_key: w.edition_key ?? null,
    serial_number: w.serial_number ?? null,
    player_name: w.player_name ?? null,
    set_name: w.set_name ?? null,
    tier: w.tier ?? null,
    series_number: w.series_number ?? null,
    image_url: w.image_url ?? null,
    fmv_usd: priced ? fmv : null,
    locked_hint: typeof w.is_locked === "boolean" ? w.is_locked : null,
    priced,
  }
}

/**
 * Indexed Top Shot moments of `source` (lowercased Flow address), optionally
 * filtered by a player-name substring. Throws on a failed read.
 */
export async function readPicker(db: SupabaseClient, source: string, q: string | null = null, slug: SwapSlug = "nba-top-shot"): Promise<PickerResult> {
  const col = swapCollection(slug)
  if (!col) throw new Error(`not a tradeable collection: ${slug}`)
  const collectionId = col.collectionId
  const COLS = "moment_id, edition_key, serial_number, player_name, set_name, tier, series_number, image_url, fmv_usd, fmv_confidence, is_locked"
  const needle = (q ?? "").replace(/[%_\\]/g, "").trim()
  // Rebuilt per run so the accent-blind retry can swap the ilike for an imatch (#207:
  // "jokic" must find the wallet's "Jokić" Moments).
  const build = (accentRegex: string | null) => {
    let query = db
      .from("wallet_moments_cache")
      .select(COLS, { count: "exact" })
      .eq("collection_id", collectionId)
      .eq("wallet_address", source)
    if (accentRegex) query = query.filter("player_name", "imatch", accentRegex)
    else if (needle) query = query.ilike("player_name", `%${needle}%`)
    return query.order("fmv_usd", { ascending: false, nullsFirst: false }).order("moment_id").limit(PICKER_LIMIT)
  }
  const first = await build(null)
  const answered = await retryEmptyWithAccentRegex(needle, first, (rx) => build(rx))
  const { data, error } = answered
  const count = (answered as { count?: number | null }).count ?? first.count
  if (error) throw new Error(`wallet_moments_cache read failed: ${error.message}`)
  const rows = ((data ?? []) as WmcRow[]).map((w) => toPickerRow(w, col.dbSlug))
  let indexed = rows.length > 0
  if (!indexed && needle) {
    // the filter may simply match nothing: ask whether the wallet has ANY rows
    const { count: any, error: anyError } = await db
      .from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("collection_id", collectionId)
      .eq("wallet_address", source)
    if (anyError) throw new Error(`wallet_moments_cache count failed: ${anyError.message}`)
    indexed = (any ?? 0) > 0
  }
  return { indexed, rows, truncated: typeof count === "number" && count > rows.length }
}

const ID_CHUNK = 200

/**
 * The All Day / Golazos / UFC picker, driven by the CHAIN (2026-11-02): the ids in the account's
 * on-chain collection now (`idsScript`) — exactly what the swap can withdraw — named and priced
 * from RPC's index. RPC's holdings also count Moments that are locked or studio-held (known issue
 * #191: 3,723 All Day rows for an account whose collection held 40), so a wmc-first picker would
 * offer Moments no transaction can move and push the movable ones past its first page; those are
 * COUNTED here (`not_in_collection`), never silently dropped. Rows are "live" (held now; neither collection locks).
 * Held ids RPC has not indexed are COUNTED (`unindexed_held`), never silently dropped. A failed
 * chain read THROWS (the caller falls back to the cached picker and says so).
 */
export async function readChainPicker(
  db: SupabaseClient,
  source: string,
  q: string | null,
  slug: Exclude<SwapSlug, "nba-top-shot">,
  readIds: (address: string) => Promise<string[] | null>,
): Promise<PickerResult> {
  const col = swapCollection(slug)
  if (!col) throw new Error(`not a tradeable collection: ${slug}`)
  const held = await readIds(source)
  if (held === null) return { indexed: true, rows: [], truncated: false, lock_state: "live", no_collection: true, unindexed_held: 0 }
  const needle = (q ?? "").replace(/[%_\\]/g, "").trim().toLowerCase()
  const COLS = "moment_id, edition_key, serial_number, player_name, set_name, tier, series_number, image_url, fmv_usd, fmv_confidence, is_locked"
  const found: WmcRow[] = []
  for (let i = 0; i < held.length; i += ID_CHUNK) {
    const chunk = held.slice(i, i + ID_CHUNK)
    const { data, error } = await db
      .from("wallet_moments_cache")
      .select(COLS)
      .eq("collection_id", col.collectionId)
      .eq("wallet_address", source)
      .in("moment_id", chunk)
      .limit(chunk.length)
    if (error) throw new Error(`wallet_moments_cache read failed: ${error.message}`)
    found.push(...((data ?? []) as WmcRow[]))
  }
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  const all = found
    .map((w) => toPickerRow(w, col.dbSlug))
    .map((r) => ({ ...r, locked_hint: false, held_live: true }))
  const matched = needle ? all.filter((r) => fold(r.player_name ?? "").includes(fold(needle))) : all
  const { count: listed, error: countError } = await db
    .from("wallet_moments_cache")
    .select("moment_id", { count: "exact", head: true })
    .eq("collection_id", col.collectionId)
    .eq("wallet_address", source)
  if (countError) throw new Error(`wallet_moments_cache count failed: ${countError.message}`)
  matched.sort((a, b) => (b.fmv_usd ?? -1) - (a.fmv_usd ?? -1) || a.moment_id.localeCompare(b.moment_id))
  return {
    indexed: true,
    rows: matched.slice(0, PICKER_LIMIT),
    truncated: matched.length > PICKER_LIMIT,
    lock_state: "live",
    unindexed_held: held.length - found.length,
    not_in_collection: typeof listed === "number" ? Math.max(0, listed - found.length) : undefined,
  }
}

/**
 * The picker rows for exactly these ids of one collection at `source` (the SAVE path: a pick
 * need not be in the picker's first page). Throws on a failed read; ids RPC has not indexed
 * are simply absent.
 */
export async function readPickedRows(db: SupabaseClient, source: string, slug: SwapSlug, ids: readonly string[]): Promise<PickerRow[]> {
  const col = swapCollection(slug)
  if (!col) throw new Error(`not a tradeable collection: ${slug}`)
  if (ids.length === 0) return []
  const { data, error } = await db
    .from("wallet_moments_cache")
    .select("moment_id, edition_key, serial_number, player_name, set_name, tier, series_number, image_url, fmv_usd, fmv_confidence, is_locked")
    .eq("collection_id", col.collectionId)
    .eq("wallet_address", source)
    .in("moment_id", [...ids])
    .limit(ids.length)
  if (error) throw new Error(`wallet_moments_cache read failed: ${error.message}`)
  return ((data ?? []) as WmcRow[]).map((w) => toPickerRow(w, col.dbSlug))
}

/** The subset of `rows` the user picked, as items to store (ids not in the picker are refused). */
export function pickItems(rows: readonly PickerRow[], ids: readonly string[]): { items: NewItem[]; unknown: string[] } {
  const byId = new Map(rows.map((r) => [r.moment_id, r]))
  const items: NewItem[] = []
  const unknown: string[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) {
      unknown.push(id)
      continue
    }
    const { locked_hint: _l, priced: _p, held_live: _h, ...item } = r
    void _l
    void _p
    void _h
    items.push(item)
  }
  return { items, unknown }
}

/**
 * #222 (2026-10-31): wmc's lock flag is a CACHE re-checked on a 7-day cycle, and a collector who
 * locks Moments in bulk (121 of one wallet's 137 "unlocked" rows were locked at 8:53 AM PT that
 * morning) is shown them as pickable until the save's chain check refuses every one. So the picker
 * reads the chain for the rows it is about to show and says which it did:
 *   · "live"   — locked_hint is the chain's answer now; held_live=false names a moment that left.
 *   · "cached" — the read failed or ran out of budget; the rows keep RPC's last check, labelled.
 * Never turns a failed read into "unlocked" or "not held".
 */
export async function withLiveLocks(
  result: PickerResult,
  source: string,
  read: (a: string, ids: string[]) => Promise<Record<string, Holding>>,
  budgetMs = 12_000,
): Promise<PickerResult> {
  if (result.rows.length === 0) return { ...result, lock_state: "live" }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const holdings = await Promise.race([
      read(source, result.rows.map((r) => r.moment_id)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lock read budget")), budgetMs) }),
    ])
    return {
      ...result,
      lock_state: "live",
      rows: result.rows.map((r) => {
        const h = holdings[r.moment_id]
        return h?.held ? { ...r, locked_hint: h.locked === true, held_live: true } : { ...r, held_live: false }
      }),
    }
  } catch {
    return { ...result, lock_state: "cached" }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
