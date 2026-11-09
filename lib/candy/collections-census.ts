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
import { isBurnt, isPack, normalizeEdition, normalizeSerial } from "@/lib/chains/solana/normalize"
import { candySetForAsset } from "@/lib/chains/solana/candy-sets"
import { loadCandyCollections } from "@/lib/candy/collections"
import { purgeCandyGhostsFor } from "@/lib/candy/ghost-purge"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const PAGE_LIMIT = 1000
const WRITE_CHUNK = 500

export interface CollectionCensusReport {
  address: string
  name: string
  pages: number
  cards: number
  wmc_inserted: number
  editions_inserted: number
  completed: boolean
  error: string | null
}

export interface CollectionsCensusResult {
  ok: boolean
  collections: CollectionCensusReport[]
  pages: number
  cards: number
  wmc_inserted: number
  editions_inserted: number
  completed: number
  escrow_remapped: number
  ghosts_purged: number | null
  error: string | null
}

export async function runCollectionsCensus(
  db: Db,
  opts: { budgetMs: number; now?: () => number },
): Promise<CollectionsCensusResult> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.budgetMs
  const out: CollectionsCensusResult = {
    ok: false, collections: [], pages: 0, cards: 0, wmc_inserted: 0, editions_inserted: 0,
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
    .select("address,name,census_page,census_cursor,census_walk_started_at,last_census_at")
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
  for (const c of (queue ?? []) as Array<{ address: string; name: string; census_page: number; census_cursor: string | null; census_walk_started_at: string | null }>) {
    if (now() > deadline) break
    const rep: CollectionCensusReport = { address: c.address, name: c.name, pages: 0, cards: 0, wmc_inserted: 0, editions_inserted: 0, completed: false, error: null }
    out.collections.push(rep)
    let page = Math.max(1, c.census_page || 1)
    let cursor: string | null = c.census_cursor || null
    let walkStarted = c.census_walk_started_at
    // A page > 1 with no cursor is a walk the old page-mode code left in flight: restart it.
    const startedThisRun = !walkStarted || page === 1 || cursor === null
    if (startedThisRun) {
      walkStarted = new Date(now()).toISOString()
      const { error } = await db.from("candy_collections").update({ census_walk_started_at: walkStarted, census_page: 1, census_cursor: null }).eq("address", c.address)
      if (error) { rep.error = `state write: ${error.message}`; errors.push(`${c.name}: ${rep.error}`); continue }
      page = 1
      cursor = null
    }
    let cardsThisWalk = 0
    while (now() <= deadline) {
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
      const cards = items.filter((a) => !isPack(a) && !isBurnt(a) && candySetForAsset(a) !== null)
      // Editions: insert-only, deduped within the page.
      const eds = new Map<string, Record<string, unknown>>()
      for (const a of cards) {
        const e = normalizeEdition(a) as unknown as Record<string, unknown>
        const k = String(e.external_id ?? "")
        if (k && !eds.has(k)) eds.set(k, e)
      }
      let failed: string | null = null
      const edRows = [...eds.values()]
      for (let i = 0; i < edRows.length && !failed; i += WRITE_CHUNK) {
        const { data, error } = await db.from("editions")
          .upsert(edRows.slice(i, i + WRITE_CHUNK), { onConflict: "external_id,collection_id", ignoreDuplicates: true })
          .select("external_id")
        if (error) failed = `editions: ${error.message}`
        else rep.editions_inserted += data?.length ?? 0
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
      const attributed = await attributeEscrowHeldToSellers(db, serials)
      out.escrow_remapped += attributed.remapped
      for (let i = 0; i < attributed.rows.length && !failed; i += WRITE_CHUNK) {
        const { data, error } = await db.from("wallet_moments_cache")
          .upsert(attributed.rows.slice(i, i + WRITE_CHUNK), { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: true })
          .select("moment_id")
        if (error) failed = `wallet_moments_cache: ${error.message}`
        else {
          rep.wmc_inserted += data?.length ?? 0
          for (const row of (data ?? []) as Array<{ moment_id: string }>) inserted.add(String(row.moment_id))
        }
      }
      if (failed) { rep.error = `page ${page}: ${failed}`; break }

      rep.pages++
      rep.cards += cards.length
      cardsThisWalk += cards.length
      const done = items.length < PAGE_LIMIT
      // last_census_items is the walk's card count only when the whole walk ran in this
      // run; a walk resumed across runs reports NULL (unknown), never a partial count.
      const patch = done
        ? { census_page: 1, census_cursor: null, census_walk_started_at: null, last_census_at: nowIso, last_census_items: startedThisRun ? cardsThisWalk : null, last_census_error: null }
        : { census_page: page + 1, census_cursor: nextCursor, last_census_error: null }
      const { error: sErr } = await db.from("candy_collections").update(patch).eq("address", c.address)
      if (sErr) { rep.error = `state write: ${sErr.message}`; break }
      if (done) { rep.completed = true; break }
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
    if (rep.completed) out.completed++
  }

  if (inserted.size > 0) {
    const g = await purgeCandyGhostsFor(db, inserted)
    if (g.error) errors.push(`ghost purge: ${g.error}`)
    else out.ghosts_purged = g.purged
  } else {
    out.ghosts_purged = 0
  }

  out.error = errors.length ? errors.slice(0, 5).join(" | ").slice(0, 900) : null
  out.ok = errors.length === 0
  return out
}
