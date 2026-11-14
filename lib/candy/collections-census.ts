// lib/candy/collections-census.ts
//
// The rotating census of every catalogued Candy collection OUTSIDE the five registry sets
// (2026-11-08; Trevor: "we need to track and measure all of this"). 396 collections and
// ~1.37M items — ~1,400 DAS pages — do not fit the one daily candy-editions walk, so each
// run reads pages inside a time budget and keeps its place in candy_collections
// (census_cursor / census_page / census_walk_started_at). A collection's walk may span
// several runs.
//
// Paging is by DAS CURSOR (keyset on asset id), never by `page` (2026-11-09): `page=N` is an
// offset whose cost grows with N, and "2022 Leadoff ICONs" failed at page 228 on four
// consecutive runs with the provider's own statement timeout — a walk that could never
// finish. census_page is now only the walk's page COUNTER; census_cursor is its position.
// A walk left in flight by the old page-mode code (census_page > 1, no cursor) has no
// position a cursor can resume from, so it restarts from the top (writes are insert-only,
// so re-reading costs index probes, not rewrites).
//
// Writes, per page:
//   editions              — INSERT-ONLY (a known edition is never rewritten)
//   wallet_moments_cache  — INSERT-ONLY on (wallet, collection, moment): an unchanged
//                           holding costs one index probe, not a row rewrite (1.4M daily
//                           rewrites would be the wmc write-amplification class). A card
//                           that moved gets its new owner's row; the end-of-run
//                           purge_candy_wmc_ghost_rows_for(<the moments INSERTED this run>)
//                           keeps the newest row per card, which retires the previous
//                           owner's. (The unscoped purge ranks all ~1.4M Candy rows and hit
//                           its 120 s timeout on the 7:57 PM PT 11-08 run.)
// Escrow-held listed cards are attributed to their listing's seller, as in the registry
// census.
//
// Honesty: a failed DAS page or write stops THAT collection for the run, records
// last_census_error and fails the run row; the page cursor advances only after the page's
// writes landed, so a failure re-reads the page next run instead of skipping it.

import { getAssetsByGroupCursor, type DasAsset } from "@/lib/chains/solana/das"
import { attributeEscrowHeldToSellers } from "@/lib/chains/solana/escrow"
import { CANDY_MLB_UUID, isBurnt, isPack, normalizeEdition, normalizeSerial } from "@/lib/chains/solana/normalize"
import { editionGroupKey, failureClass, hydrateFromJsonUri, isUnhydrated } from "@/lib/chains/solana/hydrate"
import { candySetForAsset } from "@/lib/chains/solana/candy-sets"
import { loadCandyCollections } from "@/lib/candy/collections"
import { purgeCandyGhostsFor } from "@/lib/candy/ghost-purge"
import { newLockRetryBudget, withLockRetry } from "@/lib/supabase/lock-retry"
import { loadEditionKeyAliases, NO_ALIASES } from "@/lib/candy/edition-key-aliases"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const PAGE_LIMIT = 1000
const WRITE_CHUNK = 500
// PostgREST carries .in() in the URL; ~44-char base58 ids x 150 keeps it well under limits.
const READ_CHUNK = 150

// Unhydrated assets (2026-11-09, Trevor: "Fetch it. We want data accuracy"). DAS sometimes
// returns an asset without its off-chain JSON (no traits, no image); normalized as-is it
// FABRICATED a name-only edition (4,844 editions, 328,317 cards). Now, per page:
//   1. REUSE — the card's edition never changes with its owner, so an unhydrated card whose
//      existing holdings row points at a COMPLETE edition (thumbnail present) takes that
//      edition from the DB, no fetch;
//   2. FETCH — otherwise its content.json_uri is fetched and merged (lib/chains/solana/hydrate);
//   3. SKIP — a card whose fetch fails is NOT written (never under a name-only key) and is
//      counted in unhydrated_skipped; the walk's item count is then unknown (NULL);
//   4. REPOINT — where the owner's existing row names a different edition than the one now
//      computed (e.g. a fabricated key from before), that row is overwritten with the right
//      edition and labels. Every other holding stays insert-only.
// 2026-11-09 8:15 AM PT: the first production run fetched 275 and SKIPPED 18,404 in 92 pages
// (vs 314 pages before) with no record of why. Now the run reports a failure-reason histogram
// (hydrate_fail_reasons), retries the other Arweave gateway, stops fetching for the rest of the
// run once failures dominate (BREAKER: >= 200 attempts and > 80 % failed — the walk keeps moving;
// the rest are skipped as "breaker open"), and FAILS the run when > 10 % of fetches failed, so a
// systemic fetch failure surfaces in the sentinel instead of hiding in a count.
const BREAKER_MIN_ATTEMPTS = 200
const BREAKER_FAIL_SHARE = 0.8
const RUN_FAIL_SHARE = 0.1

export interface CollectionCensusReport {
  address: string
  name: string
  pages: number
  cards: number
  wmc_inserted: number
  editions_inserted: number
  hydrated_fetched: number
  hydrated_reused: number
  unhydrated_skipped: number
  wmc_repointed: number
  listings_repointed: number
  offers_repointed: number
  editions_filled: number
  wmc_retired: number
  /** Holdings rows deleted for assets this walk SAW and classified as packs or burnt (2026-11-12). */
  wmc_noncard_retired: number
  /** Why RETIRE did not run on an otherwise eligible walk (no deletion, not an error). */
  retire_note?: string
  completed: boolean
  error: string | null
}

type EditionLabels = { external_id: string; tier: string | null; player_name: string | null; team_name: string | null; set_name: string | null; circulation_count: number | null; thumbnail_url: string | null; video_url?: string | null; rarity_label?: string | null }

/**
 * Existing holdings rows for these cards, the COMPLETE editions they point at, and the
 * INCOMPLETE ones (no thumbnail) — the latter drive FILL.
 */
async function readExisting(db: Db, ids: string[]): Promise<{ rows: Map<string, Array<{ wallet: string; edition_key: string; serial: number | null }>>; complete: Map<string, EditionLabels>; incomplete: Map<string, EditionLabels>; error: string | null }> {
  const rows = new Map<string, Array<{ wallet: string; edition_key: string; serial: number | null }>>()
  const complete = new Map<string, EditionLabels>()
  const incomplete = new Map<string, EditionLabels>()
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await db.from("wallet_moments_cache")
      .select("moment_id,wallet_address,edition_key,serial_number")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("moment_id", ids.slice(i, i + READ_CHUNK))
    if (error) return { rows, complete, incomplete, error: `wmc read: ${error.message}` }
    for (const r of (data ?? []) as Array<{ moment_id: string; wallet_address: string; edition_key: string | null; serial_number: number | null }>) {
      if (!r.edition_key) continue
      const list = rows.get(r.moment_id) ?? []
      list.push({ wallet: r.wallet_address, edition_key: r.edition_key, serial: r.serial_number })
      rows.set(r.moment_id, list)
    }
  }
  const keys = [...new Set([...rows.values()].flat().map((r) => r.edition_key))]
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const { data, error } = await db.from("editions")
      .select("external_id,tier,player_name,team_name,set_name,circulation_count,thumbnail_url,video_url,rarity_label")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("external_id", keys.slice(i, i + READ_CHUNK))
    if (error) return { rows, complete, incomplete, error: `editions read: ${error.message}` }
    for (const e of (data ?? []) as EditionLabels[]) (e.thumbnail_url ? complete : incomplete).set(e.external_id, e)
  }
  return { rows, complete, incomplete, error: null }
}

export interface CollectionsCensusResult {
  ok: boolean
  collections: CollectionCensusReport[]
  pages: number
  cards: number
  wmc_inserted: number
  editions_inserted: number
  hydrated_fetched: number
  hydrated_reused: number
  unhydrated_skipped: number
  wmc_repointed: number
  listings_repointed: number
  offers_repointed: number
  editions_filled: number
  wmc_retired: number
  wmc_noncard_retired: number
  hydrate_fail_reasons: Record<string, number>
  hydrate_fetches: number
  hydrate_unverified_groups: number
  /** metadata fetches retried after every gateway answered HTTP 429 (2026-11-09) */
  hydrate_rate_limit_retries: number
  /** lowest adaptive in-flight limit any hydrate call fell to this run; null when nothing was fetched (2026-11-10) */
  hydrate_min_concurrency: number | null
  /** widest gap between request starts any hydrate call reached this run, ms; 0 when never paced (2026-11-10) */
  hydrate_max_gap_ms: number
  // 2026-11-09 10:20 AM PT: one fetch per edition did NOT group in production (7,121 requests
  // for 6,491 cards). A small sample of what DAS actually returns for an unhydrated asset, so
  // the grouping key can be fixed from evidence, not from the on-chain name we expected.
  unhydrated_sample: Array<{ id: string; name: string | null; json_uri: string | null; group: string; content_keys: string[] }>
  completed: number
  escrow_remapped: number
  ghosts_purged: number | null
  error: string | null
}

/** RETIRE refuses when it would delete more than this share of the walk's cards (a sign something else is wrong). */
export const RETIRE_MAX_SHARE = 0.25
/**
 * …UNLESS the walk provably saw the whole collection: it walked at least this share of every holdings row we
 * keep for the collection OUTSIDE the unseen editions. 2026-11-12, Absolute Batman (2024-) #2: a 718-card walk,
 * exactly the 718 rows on its other editions, and 267 rows (178 wallets, last seen 11-08) on the fabricated
 * `…:absolute-batman-2024-2` key. The share cap refused a correct retire; a walk that accounts for everything
 * else we hold is complete, so rows it resolved to no card are not card holdings. A short walk (DAS returning
 * part of a collection) fails this test and the cap still applies. ⚠ CORRECTED 7:30 PM PT: those 267 were NOT
 * cards DAS stopped returning — the walk fetched all 267 (hydrated_fetched 267) and classified them as packs or
 * burnt; NON-CARD retire (below) now removes such rows by moment id on that per-asset evidence, first.
 */
export const RETIRE_COMPLETE_WALK_SHARE = 0.98

/** PostgREST's per-request row cap. An unpaged read that returns this many rows may be truncated. */
const POSTGREST_ROW_CAP = 1000

/**
 * After a clean complete walk: delete holdings rows that sit on a THUMBNAIL-LESS edition of this collection
 * whose key no card of the walk resolved to. See RETIRE in runCollectionsCensus.
 */
async function retireUnseenOnLabelless(db: Db, prefix: string, walkKeys: Set<string>, walkCards: number): Promise<{ retired: number; error: string | null; note?: string }> {
  // A walk that returned NO cards confirms nothing (Overdrive Rewards, 11-12: 0-card walk, 24 rows on a
  // fabricated `…reward-pack-10` key) — fail open WITHOUT failing the run every rotation.
  if (walkCards === 0) return { retired: 0, error: null, note: "skipped: the walk returned no cards" }
  const { data: eds, error } = await db.from("editions")
    .select("external_id")
    .eq("collection_id", CANDY_MLB_UUID)
    .is("thumbnail_url", null)
    .like("external_id", `${prefix}:%`)
  if (error) return { retired: 0, error: `editions read: ${error.message}` }
  // 2026-11-13: PostgREST returns at most POSTGREST_ROW_CAP rows and this read is unpaged, so a full page may be a
  // PARTIAL, arbitrary list — fail closed rather than retire from it (the record read below does the same).
  if ((eds ?? []).length >= POSTGREST_ROW_CAP) {
    return { retired: 0, error: `editions read: ${POSTGREST_ROW_CAP}-row cap reached; not retiring from a possibly partial list` }
  }
  // LIKE treats `_` in a slug as a wildcard: keep only keys that really start with this prefix.
  const keys = ((eds ?? []) as Array<{ external_id: string }>).map((e) => e.external_id).filter((k) => k.startsWith(`${prefix}:`) && !walkKeys.has(k))
  if (!keys.length) return { retired: 0, error: null }
  // Through a scoped SQL function, never a PostgREST .delete(): rpc_delete_guard blocks a wmc DELETE spanning
  // > 3 wallets (it did, 9:57 AM PT 11-12). The function re-checks each key is still thumbnail-less and
  // refuses — deleting nothing — above the cap (pinned: supabase/tests/candy_retire_unseen_labelless_wmc.sql).
  const cap = Math.floor(Math.max(10, walkCards * RETIRE_MAX_SHARE))
  const { data, error: rErr } = await db.rpc("candy_retire_unseen_labelless_wmc", { p_edition_keys: keys, p_max_rows: cap })
  if (rErr) return { retired: 0, error: `rpc: ${rErr.message}` }
  const res = (data ?? {}) as { retired?: number; rows?: number; refused?: boolean }
  if (res.refused) {
    const unseenRows = res.rows ?? 0
    // Completeness test (RETIRE_COMPLETE_WALK_SHARE). LIKE's `_` wildcard can only OVER-count the collection's
    // rows, which makes the test harder to pass — it fails closed.
    const { count: total, error: tErr } = await db.from("wallet_moments_cache")
      .select("moment_id", { count: "exact", head: true })
      .eq("collection_id", CANDY_MLB_UUID)
      .like("edition_key", `${prefix}:%`)
    const refusal = `refused: ${unseenRows} rows on unseen label-less editions vs a ${walkCards}-card walk`
    if (tErr) return { retired: 0, error: `${refusal}; completeness count: ${tErr.message}` }
    const otherRows = (total ?? 0) - unseenRows
    if (!(unseenRows > 0 && otherRows > 0 && walkCards >= otherRows * RETIRE_COMPLETE_WALK_SHARE)) {
      return { retired: 0, error: `${refusal} (walk saw ${walkCards} of ${otherRows} rows held outside them)` }
    }
    // Exactly the rows counted: the function refuses again if more appeared since.
    const again = await db.rpc("candy_retire_unseen_labelless_wmc", { p_edition_keys: keys, p_max_rows: unseenRows })
    if (again.error) return { retired: 0, error: `rpc: ${again.error.message}` }
    const r2 = (again.data ?? {}) as { retired?: number; refused?: boolean; rows?: number }
    if (r2.refused) return { retired: 0, error: `${refusal}; re-check refused at ${r2.rows ?? "?"} rows` }
    if (typeof r2.retired !== "number") return { retired: 0, error: "rpc: no retired count" }
    return { retired: r2.retired, error: null }
  }
  if (typeof res.retired !== "number") return { retired: 0, error: "rpc: no retired count" }
  return { retired: res.retired, error: null }
}

export async function runCollectionsCensus(
  db: Db,
  opts: { budgetMs: number; now?: () => number; lockSleep?: (ms: number) => Promise<void> },
): Promise<CollectionsCensusResult> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.budgetMs
  const lockBudget = newLockRetryBudget()
  const lockOpts = opts.lockSleep ? { sleep: opts.lockSleep } : {}
  const out: CollectionsCensusResult = {
    ok: false, collections: [], pages: 0, cards: 0, wmc_inserted: 0, editions_inserted: 0,
    hydrated_fetched: 0, hydrated_reused: 0, unhydrated_skipped: 0, wmc_repointed: 0, listings_repointed: 0, offers_repointed: 0, editions_filled: 0, wmc_retired: 0, wmc_noncard_retired: 0, hydrate_fail_reasons: {}, hydrate_fetches: 0, hydrate_unverified_groups: 0, hydrate_rate_limit_retries: 0, hydrate_min_concurrency: null, hydrate_max_gap_ms: 0, unhydrated_sample: [],
    completed: 0, escrow_remapped: 0, ghosts_purged: null, error: null,
  }

  const catalog = await loadCandyCollections(db)
  if (catalog.error) {
    out.error = `catalog read failed: ${catalog.error}`
    return out
  }

  // In-flight walks first, then the collection whose last completed walk is oldest.
  const { data: queue, error: qErr } = await db
    .from("candy_collections")
    .select("address,name,edition_prefix,census_page,census_cursor,census_walk_started_at,last_census_at,census_walk_tracked,census_walk_labelless_seen,census_walk_skipped,census_walk_cards")
    .neq("kind", "test")
    .eq("census", false)
    .not("set_id", "is", null)
    .not("edition_prefix", "is", null)
    .order("census_walk_started_at", { ascending: true, nullsFirst: false })
    .order("last_census_at", { ascending: true, nullsFirst: true })
    .order("address", { ascending: true })
    .limit(500)
  if (qErr) {
    out.error = `queue read failed: ${qErr.message ?? String(qErr)}`
    return out
  }

  const errors: string[] = []
  const inserted = new Set<string>()
  let fetchAttempts = 0
  let fetchFailures = 0
  const breakerOpen = () => fetchAttempts >= BREAKER_MIN_ATTEMPTS && fetchFailures / fetchAttempts > BREAKER_FAIL_SHARE
  for (const c of (queue ?? []) as Array<{ address: string; name: string; edition_prefix?: string | null; census_page: number; census_cursor: string | null; census_walk_started_at: string | null; census_walk_tracked?: boolean | null; census_walk_labelless_seen?: string[] | null; census_walk_skipped?: number | null; census_walk_cards?: number | null }>) {
    if (now() > deadline) break
    const rep: CollectionCensusReport = { address: c.address, name: c.name, pages: 0, cards: 0, wmc_inserted: 0, editions_inserted: 0, hydrated_fetched: 0, hydrated_reused: 0, unhydrated_skipped: 0, wmc_repointed: 0, listings_repointed: 0, offers_repointed: 0, editions_filled: 0, wmc_retired: 0, wmc_noncard_retired: 0, completed: false, error: null }
    out.collections.push(rep)
    let page = Math.max(1, c.census_page || 1)
    let cursor: string | null = c.census_cursor || null
    let walkStarted = c.census_walk_started_at
    // A page > 1 with no cursor is a walk the old page-mode code left in flight: restart it.
    const startedThisRun = !walkStarted || page === 1 || cursor === null
    if (startedThisRun) {
      walkStarted = new Date(now()).toISOString()
      const { error } = await db.from("candy_collections").update({ census_walk_started_at: walkStarted, census_page: 1, census_cursor: null, census_walk_tracked: true, census_walk_labelless_seen: [], census_walk_skipped: 0, census_walk_cards: 0 }).eq("address", c.address)
      if (error) { rep.error = `state write: ${error.message}`; errors.push(`${c.name}: ${rep.error}`); continue }
      page = 1
      cursor = null
    }
    let cardsThisWalk = 0
    let skippedThisWalk = 0
    // Every edition key a card of THIS walk resolved to (computed, or reused) — drives RETIRE.
    const walkKeys = new Set<string>()
    // CROSS-RUN RECORD (2026-11-12): a walk that spans runs (2022 Leadoff ICONs, ~370k cards, 4 runs) keeps
    // the LABEL-LESS keys its cards resolved to, and its skip count, on candy_collections, so RETIRE can run
    // at its end too. Only a walk that STARTED under this code is tracked (census_walk_tracked) — a walk
    // resumed from before it retires nothing. Label-less keys only: the set stays small.
    const tracked = startedThisRun || c.census_walk_tracked === true
    const priorSeen = startedThisRun ? [] : (c.census_walk_labelless_seen ?? [])
    const priorSkipped = startedThisRun ? 0 : (c.census_walk_skipped ?? 0)
    const priorCards = startedThisRun ? 0 : (c.census_walk_cards ?? 0)
    for (const k of priorSeen) walkKeys.add(k)
    let labellessKeys: Set<string> | null = null
    if (c.edition_prefix) {
      const { data: le, error: leErr } = await db.from("editions")
        .select("external_id")
        .eq("collection_id", CANDY_MLB_UUID)
        .is("thumbnail_url", null)
        .like("external_id", `${c.edition_prefix}:%`)
      // A failed read leaves the record unknown → this walk will not RETIRE (fails open).
      // 2026-11-13: a read that hit the row cap may be partial, and a key missing from it would never be recorded
      // and could be retired at the end of the walk — an unknown record, the same as a failed read.
      labellessKeys = leErr || (le ?? []).length >= POSTGREST_ROW_CAP
        ? null
        : new Set(((le ?? []) as Array<{ external_id: string }>).map((e) => e.external_id))
    }
    const recordOk = labellessKeys !== null
    // #247 (2026-11-13): one canonical key per card. A key in candy_edition_key_aliases is resolved to its
    // canonical BEFORE it is compared with the card's existing holding (lib/candy/edition-key-aliases.ts); a
    // failed read fails the collection rather than walking without the map.
    const al = c.edition_prefix ? await loadEditionKeyAliases(db, c.edition_prefix) : { aliases: NO_ALIASES, error: null }
    if (al.error) rep.error = al.error
    const canonOf = al.aliases.canonOf
    const canonLabels = al.aliases.labels
    while (!rep.error && now() <= deadline) {
      let items: DasAsset[]
      let nextCursor: string | null
      try {
        const res = await getAssetsByGroupCursor(c.address, cursor, PAGE_LIMIT)
        items = (res?.items ?? []) as DasAsset[]
        nextCursor = typeof res?.cursor === "string" && res.cursor ? res.cursor : null
        // A full page with no cursor has no next position: refuse it rather than end the
        // walk there (that would stamp a PARTIAL walk as complete).
        if (items.length >= PAGE_LIMIT && !nextCursor) throw new Error("DAS returned a full page without a cursor")
      } catch (e) {
        rep.error = `page ${page}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`
        break
      }
      // Existing holdings for every card on the page: drives REUSE and REPOINT.
      const ex = await readExisting(db, items.map((a) => a.id).filter(Boolean))
      if (ex.error) { rep.error = `page ${page}: ${ex.error}`; break }
      const reused: Array<{ asset: DasAsset; ed: EditionLabels; serial: number | null }> = []
      const toFetch: DasAsset[] = []
      const ready: DasAsset[] = []
      for (const a of items) {
        if (!isUnhydrated(a) || isBurnt(a)) { ready.push(a); continue }
        // 2026-11-09: a 1-of-1 edition is reusable only when it is THIS card's own (keyed by
        // its asset id, lib/chains/solana/normalize.ts). A name-keyed 1/1 merged different cards
        // (2022 All-Star Tricons; The Bat Cowl Collection), so reusing it would pin the card to
        // the wrong edition forever: fetch instead, and the card is re-keyed and repointed.
        const known = (ex.rows.get(a.id) ?? []).find((r) => {
          const ed = ex.complete.get(r.edition_key)
          return !!ed && !(ed.circulation_count === 1 && !r.edition_key.endsWith(`-${a.id.slice(0, 12)}`))
        })
        // #247: a card reused from an ALIAS edition takes its canonical edition (same card, one key)
        const knownCanon = known ? canonOf.get(known.edition_key) : undefined
        if (known) reused.push({ asset: a, ed: knownCanon ? (canonLabels.get(knownCanon) as EditionLabels) : ex.complete.get(known.edition_key)!, serial: known.serial })
        else toFetch.push(a)
      }
      for (const a of toFetch) {
        if (out.unhydrated_sample.length >= 5) break
        out.unhydrated_sample.push({
          id: a.id,
          name: a.content?.metadata?.name ?? null,
          json_uri: a.content?.json_uri ?? null,
          group: editionGroupKey(a),
          content_keys: Object.keys(a.content ?? {}),
        })
      }
      const fetched = !toFetch.length
        ? { hydrated: [] as DasAsset[], failed: [] as Array<{ id: string; reason: string }> }
        : breakerOpen()
          ? { hydrated: [] as DasAsset[], failed: toFetch.map((a) => ({ id: a.id, reason: "breaker open" })) }
          : await hydrateFromJsonUri(toFetch)
      for (const f of fetched.failed) {
        const k = failureClass(f.reason)
        out.hydrate_fail_reasons[k] = (out.hydrate_fail_reasons[k] ?? 0) + 1
      }
      if ("fetches" in fetched) out.hydrate_fetches += fetched.fetches
      if ("unverified_groups" in fetched) out.hydrate_unverified_groups += fetched.unverified_groups
      if ("rate_limit_retries" in fetched) out.hydrate_rate_limit_retries += fetched.rate_limit_retries
      if ("max_gap_ms" in fetched) out.hydrate_max_gap_ms = Math.max(out.hydrate_max_gap_ms, fetched.max_gap_ms)
      if ("min_concurrency" in fetched) out.hydrate_min_concurrency = Math.min(out.hydrate_min_concurrency ?? fetched.min_concurrency, fetched.min_concurrency)
      if (!(fetched.failed[0]?.reason === "breaker open")) {
        fetchAttempts += toFetch.length
        fetchFailures += fetched.failed.length
      }
      rep.hydrated_reused += reused.length
      rep.hydrated_fetched += fetched.hydrated.length
      rep.unhydrated_skipped += fetched.failed.length
      skippedThisWalk += fetched.failed.length
      const cards = [...ready, ...fetched.hydrated].filter((a) => !isPack(a) && !isBurnt(a) && candySetForAsset(a) !== null)
      // NON-CARD (2026-11-12): an asset this walk SAW with its metadata and classified as a PACK or BURNT is
      // not a card holding — yet the pre-11-09 unhydrated path stored some as cards (Overdrive Rewards: 24
      // reward packs on a label-less `…reward-pack-10` key; every walk hydrated them and wrote 0 cards). Their
      // rows are retired by moment id: per-asset evidence, no share cap. Only assets with metadata qualify —
      // an unhydrated card whose fetch failed is skipped above, never classified here.
      const nonCardIds = [...ready, ...fetched.hydrated]
        .filter((a) => a.id && (isPack(a) || isBurnt(a)) && ex.rows.has(a.id))
        .map((a) => a.id)
      // Editions: insert-only, deduped within the page.
      const eds = new Map<string, Record<string, unknown>>()
      for (const a of cards) {
        let e = normalizeEdition(a) as unknown as Record<string, unknown>
        let k = String(e.external_id ?? "")
        // #247: an alias key is written as its canonical, with the canonical edition's labels
        const ck = canonOf.get(k)
        if (ck) {
          e = { ...e, ...canonLabels.get(ck), external_id: ck }
          k = ck
        }
        if (k && !eds.has(k)) eds.set(k, e)
      }
      let failed: string | null = null
      for (const k of eds.keys()) walkKeys.add(k)
      for (const r of reused) walkKeys.add(r.ed.external_id)
      // 2026-11-13 (review): the cross-run record keeps walkKeys ∩ labellessKeys, and labellessKeys is read once at
      // the start of the run — so a THUMBNAIL-LESS edition this run creates was never recorded, and the last run of
      // a multi-run walk retired the holdings this same walk wrote onto it. Record every key written without a
      // thumbnail. Over-recording is safe: a recorded key is only ever protected from RETIRE.
      if (labellessKeys) for (const [k, e] of eds) if (!e.thumbnail_url) labellessKeys.add(k)
      const edRows = [...eds.values()]
      for (let i = 0; i < edRows.length && !failed; i += WRITE_CHUNK) {
        const { data, error } = await db.from("editions")
          .upsert(edRows.slice(i, i + WRITE_CHUNK), { onConflict: "external_id,collection_id", ignoreDuplicates: true })
          .select("external_id")
        if (error) failed = `editions: ${error.message}`
        else rep.editions_inserted += data?.length ?? 0
      }
      // FILL (2026-11-12, #246 residual). An edition first written from an UNHYDRATED card
      // (before the 11-09 fix) has no thumbnail / circulation / tier, and the insert-only upsert
      // above discards the labels a later HYDRATED card computes for the SAME key — so 690
      // editions (51,318 cards) stayed label-less with 0 repoints for a day: the cards were
      // keyed right, the edition row was never completed. Fill only NULL labels, only on a row
      // that still has no thumbnail (the .is guard makes a concurrent fill a no-op), only from a
      // computed edition that HAS one. Once complete, its unhydrated cards are REUSED, not refetched.
      for (const [k, cur] of ex.incomplete) {
        if (failed) break
        const e = eds.get(k) as Partial<EditionLabels> | undefined
        if (!e?.thumbnail_url) continue
        const patch: Record<string, unknown> = { thumbnail_url: e.thumbnail_url }
        if (!cur.circulation_count && e.circulation_count) patch.circulation_count = e.circulation_count
        if (cur.tier == null && e.tier != null) patch.tier = e.tier
        if (cur.player_name == null && e.player_name != null) patch.player_name = e.player_name
        if (cur.team_name == null && e.team_name != null) patch.team_name = e.team_name
        if (cur.video_url == null && e.video_url != null) patch.video_url = e.video_url
        if (cur.rarity_label == null && e.rarity_label != null) patch.rarity_label = e.rarity_label
        const { data, error } = await db.from("editions")
          .update(patch)
          .eq("collection_id", CANDY_MLB_UUID)
          .eq("external_id", k)
          .is("thumbnail_url", null)
          .select("external_id")
        if (error) failed = `editions fill: ${error.message}`
        else rep.editions_filled += data?.length ?? 0
      }
      // Holdings: insert-only; escrow-held listed cards credited to their seller.
      const nowIso = new Date(now()).toISOString()
      // Rows are born LABELLED (tier / player / set / mint count / team from the edition).
      // Written without them, 938k rows waited on the registry census' whole-collection
      // denorm, which then crawled every page and was killed at the wall (2026-11-08).
      const serials = cards
        .map((a) => {
          const s = normalizeSerial(a)
          if (!s.moment_id || !s.wallet_address) return null
          const ck = canonOf.get(String(s.edition_key ?? ""))
          if (ck) s.edition_key = ck
          const ed = eds.get(String(s.edition_key ?? "")) as Record<string, unknown> | undefined
          return {
            ...s,
            tier: (ed?.tier as string | null | undefined) ?? null,
            player_name: ((ed?.player_name ?? ed?.team_name) as string | null | undefined) ?? null,
            set_name: (ed?.set_name as string | null | undefined) ?? null,
            mint_count: (ed?.circulation_count as number | null | undefined) ?? null,
            team_name: (ed?.team_name as string | null | undefined) ?? null,
            last_seen_at: nowIso,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      // REUSED cards: edition and labels from the complete edition their card already has.
      for (const { asset, ed, serial } of reused) {
        const owner = asset.ownership?.owner ?? ""
        if (!asset.id || !owner) continue
        serials.push({
          wallet_address: owner, collection_id: CANDY_MLB_UUID, moment_id: asset.id, edition_key: ed.external_id,
          serial_number: serial, image_url: ed.thumbnail_url,
          tier: ed.tier, player_name: ed.player_name ?? ed.team_name, set_name: ed.set_name,
          mint_count: ed.circulation_count, team_name: ed.team_name, last_seen_at: nowIso,
        } as (typeof serials)[number])
      }
      const attributed = await attributeEscrowHeldToSellers(db, serials)
      out.escrow_remapped += attributed.remapped
      // 2026-11-13 (review): a FAILED seller lookup leaves escrow-held cards on Magic Eden's escrow address, so this
      // walk cannot vouch for which collector holds them — count them as skipped, which keeps RETIRE off this walk
      // (the same rule as a card whose metadata fetch failed).
      if (attributed.error) skippedThisWalk += Math.max(1, attributed.unmatched)
      // REPOINT the owner's existing row when it names a different edition; the rest stay insert-only.
      const repoint = attributed.rows.filter((r) => (ex.rows.get(String(r.moment_id)) ?? []).some((e) => e.wallet === r.wallet_address && e.edition_key !== r.edition_key))
      const repointSet = new Set(repoint)
      const insertOnly = attributed.rows.filter((r) => !repointSet.has(r))
      for (let i = 0; i < insertOnly.length && !failed; i += WRITE_CHUNK) {
        // Lock retry (2026-11-12): 3:57 PM PT run failed on "lock timeout" here — the wmc-fmv-populate
        // Candy step holds rows briefly; the same wrapper fixed candy-editions-ingest on 11-11.
        const chunk = insertOnly.slice(i, i + WRITE_CHUNK)
        const { data, error } = await withLockRetry<Array<{ moment_id: string }>>(
          () => db.from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: true })
            .select("moment_id"),
          lockBudget, lockOpts,
        )
        if (error) failed = `wallet_moments_cache: ${error.message}`
        else {
          rep.wmc_inserted += data?.length ?? 0
          for (const row of (data ?? []) as Array<{ moment_id: string }>) inserted.add(String(row.moment_id))
        }
      }
      for (let i = 0; i < repoint.length && !failed; i += WRITE_CHUNK) {
        const chunk = repoint.slice(i, i + WRITE_CHUNK)
        const { data, error } = await withLockRetry<Array<{ moment_id: string }>>(
          () => db.from("wallet_moments_cache")
            .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: false })
            .select("moment_id"),
          lockBudget, lockOpts,
        )
        if (error) failed = `wallet_moments_cache repoint: ${error.message}`
        else rep.wmc_repointed += data?.length ?? 0
      }
      // A listing follows its CARD (2026-11-09, inbox 2026-11-10T0430Z): the repointed cards'
      // candy_listings rows (both venues, active or retired) move to the card's new edition, so
      // listing history stays on the real edition and the orphan cleanups can retire the old one.
      // One set-based call per page; a failure fails the page (cursor not advanced, re-read).
      if (!failed && repoint.length) {
        const { data, error } = await db.rpc("candy_repoint_listings_to_card_edition", { p_mints: repoint.map((r) => String(r.moment_id)) })
        if (error) failed = `listings repoint: ${error.message}`
        else rep.listings_repointed += typeof data === "number" ? data : 0
      }
      // …and so does an OFFER (2026-11-12): 263 historical bids left on fabricated editions kept 43 emptied
      // #246 editions "referenced", so the orphan cleanup could not retire them.
      if (!failed && repoint.length) {
        const { data, error } = await db.rpc("candy_repoint_offers_to_card_edition", { p_mints: repoint.map((r) => String(r.moment_id)) })
        if (error) failed = `offers repoint: ${error.message}`
        else rep.offers_repointed += typeof data === "number" ? data : 0
      }
      if (!failed && nonCardIds.length) {
        const { data, error } = await db.rpc("candy_retire_noncard_wmc", { p_moment_ids: nonCardIds })
        if (error) failed = `non-card retire: ${error.message}`
        else rep.wmc_noncard_retired += typeof data === "number" ? data : 0
      }
      if (failed) { rep.error = `page ${page}: ${failed}`; break }

      rep.pages++
      rep.cards += cards.length + reused.length
      cardsThisWalk += cards.length + reused.length
      // 2026-11-13: a short page ends the walk only when DAS gave NO next cursor (or the page is empty). A short page
      // WITH a cursor is followed: ending there would stamp a possibly partial walk complete and run RETIRE on it.
      // The cost when DAS hands a cursor on its last page is one extra, empty page per walk.
      const done = items.length === 0 || (items.length < PAGE_LIMIT && !nextCursor)
      // last_census_items is the walk's card count only when the whole walk ran in this
      // run; a walk resumed across runs reports NULL (unknown), never a partial count.
      const patch = done
        ? { census_page: 1, census_cursor: null, census_walk_started_at: null, last_census_at: nowIso, last_census_items: startedThisRun && skippedThisWalk === 0 ? cardsThisWalk : null, last_census_error: null, census_walk_tracked: false, census_walk_labelless_seen: [], census_walk_skipped: 0, census_walk_cards: 0 }
        : {
            census_page: page + 1, census_cursor: nextCursor, last_census_error: null,
            census_walk_labelless_seen: labellessKeys ? [...walkKeys].filter((k) => labellessKeys!.has(k)) : [],
            census_walk_skipped: priorSkipped + skippedThisWalk + (recordOk ? 0 : 1),
            census_walk_cards: priorCards + cardsThisWalk,
          }
      const { error: sErr } = await db.from("candy_collections").update(patch).eq("address", c.address)
      if (sErr) { rep.error = `state write: ${sErr.message}`; break }
      if (done) {
        rep.completed = true
        // RETIRE (2026-11-12, #246 residual) — only after a CLEAN, COMPLETE walk that was TRACKED from its
        // start (one run, or several via the cross-run record above) with no card skipped. A card the walk saw
        // either FILLED its label-less edition, was REPOINTED off it, or REUSED a complete one, so a
        // row still on a thumbnail-less edition whose key NO card of this walk produced is a card DAS
        // no longer returns in this collection (burnt / gone) — the add-only census never retires it.
        // Aquaman (2025-) #3: 360 rows vs a 350-card walk, the 10 extra exactly the fabricated
        // `…:aquaman-2025` edition's. Fails OPEN: an untracked walk, a skipped card, a failed record read
        // or no prefix retires nothing; more than RETIRE_MAX_SHARE of the walk refuses (and fails the run).
        if (tracked && recordOk && priorSkipped + skippedThisWalk === 0 && c.edition_prefix) {
          const r = await retireUnseenOnLabelless(db, c.edition_prefix, walkKeys, priorCards + cardsThisWalk)
          if (r.error) { rep.error = `retire: ${r.error}`; break }
          if (r.note) rep.retire_note = r.note
          rep.wmc_retired += r.retired
        }
        break
      }
      page++
      cursor = nextCursor
    }
    if (rep.error) {
      errors.push(`${c.name}: ${rep.error}`)
      const { error: eErr } = await db.from("candy_collections").update({ last_census_error: rep.error.slice(0, 300) }).eq("address", c.address)
      if (eErr) errors.push(`${c.name}: error stamp: ${eErr.message}`)
    }
    out.pages += rep.pages
    out.cards += rep.cards
    out.wmc_inserted += rep.wmc_inserted
    out.editions_inserted += rep.editions_inserted
    out.hydrated_fetched += rep.hydrated_fetched
    out.hydrated_reused += rep.hydrated_reused
    out.unhydrated_skipped += rep.unhydrated_skipped
    out.wmc_repointed += rep.wmc_repointed
    out.listings_repointed += rep.listings_repointed
    out.offers_repointed += rep.offers_repointed
    out.editions_filled += rep.editions_filled
    out.wmc_retired += rep.wmc_retired
    out.wmc_noncard_retired += rep.wmc_noncard_retired
    if (rep.completed) out.completed++
  }

  if (inserted.size > 0) {
    const g = await purgeCandyGhostsFor(db, inserted)
    if (g.error) errors.push(`ghost purge: ${g.error}`)
    else out.ghosts_purged = g.purged
  } else {
    out.ghosts_purged = 0
  }

  if (fetchAttempts > 0 && fetchFailures / fetchAttempts > RUN_FAIL_SHARE) {
    const top = Object.entries(out.hydrate_fail_reasons).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", ")
    errors.unshift(`metadata fetch failed for ${fetchFailures} of ${fetchAttempts} unhydrated cards (${top})`)
  }
  out.error = errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null
  out.ok = errors.length === 0
  return out
}
