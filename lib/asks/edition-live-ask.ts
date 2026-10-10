// lib/asks/edition-live-ask.ts
//
// The LIVE low ask for a batch of editions in one collection: what a buyer
// would pay right now. Added 2026-10-10 (known-issues #182).
//
// WHY. `get_wallet_moments_with_fmv` exposes `fmv_snapshots.floor_price_usd` as
// `low_ask`, and on every sales-priced row that column is the window's LOWEST
// SALE, not a listing (schema-truth.md). The 10-10 binder fix (3919afa9a) stopped
// rendering it as "Ask $X" and left sales-priced rows honest but ask-less. This
// supplies the real ask.
//
// THE RULE IS get_team_checklist's (its 2026-10-03 "floor_usd is the LIVE low
// ask" comment) with ONE deliberate difference: edition_offers freshness reads
// low_ask_confirmed_at, where the checklist reads updated_at (see the loop below):
//   1. All Day: allday_edition_floor_ask (ghost listings already excluded);
//   2. edition_offers.low_ask, last SEEN (low_ask_confirmed_at) in the last 7 days;
//   3. badge_editions.low_ask, updated in the last 7 days;
//   Candy: candy_listing_floor.confirmed_floor_usd (lib/fmv-candy-ceiling.ts);
// and an ask is used ONLY when the edition has an FMV and the ask is <= 3x it
// (the estate's disconnected-ask multiple): a lone ask on an unpriced edition is
// the troll shape. Pinnacle and UFC have no source here and get none.
//
// ⚠ SQL TWIN: public.edition_live_ask(collection_id, edition_key) applies this
// same rule for the FMV-alert functions (20261010142824, known-issues #183).
// Change one, change both; supabase/tests/edition_live_ask.sql pins the SQL side.
//
// HONESTY. Every read binds its error. A failed read leaves the affected keys
// WITHOUT an ask (the caller renders no ask, which claims nothing) and is
// reported in `errors`, never as "no ask exists".

import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"

export type LiveAskSource = "allday_floor" | "edition_offers" | "badge_editions" | "candy_confirmed_floor"

export interface LiveAsk {
  ask: number
  source: LiveAskSource
}

export interface LiveAskResult {
  asks: Map<string, LiveAsk>
  errors: string[]
}

// From the registry, never retyped (a hand-typed UUID here was wrong once already).
const ALL_DAY = COLLECTION_UUID_BY_SLUG["nfl-all-day"]
const CANDY = COLLECTION_UUID_BY_SLUG["candy-mlb"]
const MAX_ASK_AGE_DAYS = 7
const MAX_ASK_TO_FMV = 3
const CHUNK = 300

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function resolveLiveAsks(
  db: Db,
  collectionId: string,
  editionKeys: string[],
): Promise<LiveAskResult> {
  const asks = new Map<string, LiveAsk>()
  const errors: string[] = []
  const keys = [...new Set(editionKeys.filter((k) => typeof k === "string" && k.length > 0))]
  if (keys.length === 0) return { asks, errors }
  const sinceIso = new Date(Date.now() - MAX_ASK_AGE_DAYS * 86_400_000).toISOString()

  // key -> edition id, and edition id -> FMV (the <= 3x gate needs a price).
  const idByKey = new Map<string, string>()
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const { data, error } = await db
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", collectionId)
      .in("external_id", slice)
    if (error) {
      errors.push(`editions: ${error.message}`)
      continue
    }
    for (const r of (data ?? []) as Array<{ id: string; external_id: string }>) idByKey.set(r.external_id, r.id)
  }
  const ids = [...idByKey.values()]
  const fmvById = new Map<string, number>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data, error } = await db.from("edition_fmv_current").select("edition_id, fmv_usd").in("edition_id", slice)
    if (error) {
      errors.push(`edition_fmv_current: ${error.message}`)
      continue
    }
    for (const r of (data ?? []) as Array<{ edition_id: string; fmv_usd: unknown }>) {
      const f = Number(r.fmv_usd)
      if (Number.isFinite(f) && f > 0) fmvById.set(r.edition_id, f)
    }
  }

  // Candidate asks by priority; the first CONNECTED one (<= 3x FMV) wins.
  const candidates = new Map<string, Array<{ ask: number; source: LiveAskSource; pri: number }>>()
  const offer = (key: string, ask: unknown, source: LiveAskSource, pri: number) => {
    const a = Number(ask)
    if (!Number.isFinite(a) || a <= 0) return
    const list = candidates.get(key) ?? []
    list.push({ ask: a, source, pri })
    candidates.set(key, list)
  }

  if (collectionId === ALL_DAY && ids.length > 0) {
    const keyById = new Map([...idByKey].map(([k, id]) => [id, k]))
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const { data, error } = await db.from("allday_edition_floor_ask").select("edition_id, floor_ask").in("edition_id", slice)
      if (error) {
        errors.push(`allday_edition_floor_ask: ${error.message}`)
        continue
      }
      for (const r of (data ?? []) as Array<{ edition_id: string; floor_ask: unknown }>) {
        const k = keyById.get(r.edition_id)
        if (k) offer(k, r.floor_ask, "allday_floor", 1)
      }
    }
  }

  if (collectionId === CANDY && ids.length > 0) {
    const { fetchCandyConfirmedFloors } = await import("@/lib/fmv-candy-ceiling")
    const res = await fetchCandyConfirmedFloors(db, ids)
    if (res.error) errors.push(`candy_listing_floor: ${res.error}`)
    const keyById = new Map([...idByKey].map(([k, id]) => [id, k]))
    for (const [id, ask] of res.floors) {
      const k = keyById.get(id)
      if (k) offer(k, ask, "candy_confirmed_floor", 1)
    }
  }

  // Freshness is judged on when the ASK was last SEEN, not when the row last
  // changed. edition_offers.updated_at moves only on a CHANGE, and also when the
  // row's highest_offer changes (sync_edition_offers_from_atlas), so it both
  // drops an ask re-observed unchanged and passes one nobody has seen for days
  // (10-10: 31 Top Shot editions showed a 10-day-unseen ask below the fresh
  // badge ask). low_ask_confirmed_at is the re-confirmed observation time.
  // badge_editions is rewritten on every GQL refresh, so its updated_at is it.
  for (const [table, source, pri, seenCol] of [
    ["edition_offers", "edition_offers", 2, "low_ask_confirmed_at"],
    ["badge_editions", "badge_editions", 3, "updated_at"],
  ] as const) {
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK)
      const { data, error } = await db
        .from(table)
        .select("external_id, low_ask")
        .eq("collection_id", collectionId)
        .in("external_id", slice)
        .gt("low_ask", 0)
        .gt(seenCol, sinceIso)
      if (error) {
        errors.push(`${table}: ${error.message}`)
        continue
      }
      for (const r of (data ?? []) as Array<{ external_id: string; low_ask: unknown }>) offer(r.external_id, r.low_ask, source, pri)
    }
  }

  for (const [key, list] of candidates) {
    const id = idByKey.get(key)
    const fmv = id ? fmvById.get(id) : undefined
    if (fmv == null) continue // no FMV -> no ask (the troll shape stays unpriced)
    const best = list.sort((a, b) => a.pri - b.pri).find((c) => c.ask <= fmv * MAX_ASK_TO_FMV)
    if (best) asks.set(key, { ask: best.ask, source: best.source })
  }
  return { asks, errors }
}
