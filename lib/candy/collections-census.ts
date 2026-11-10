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
  completed: boolean
  error: string | null
}

type EditionLabels = { external_id: string; tier: string | null; player_name: string | null; team_name: string | null; set_name: string | null; circulation_count: number | null; thumbnail_url: string | null }

/** Existing holdings rows for these cards, and the COMPLETE editions they point at. */
async function readExisting(db: Db, ids: string[]): Promise<{ rows: Map<string, Array<{ wallet: string; edition_key: string; serial: number | null }>>; complete: Map<string, EditionLabels>; error: string | null }> {
  const rows = new Map<string, Array<{ wallet: string; edition_key: string; serial: number | null }>>()
  const complete = new Map<string, EditionLabels>()
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const { data, error } = await db.from("wallet_moments_cache")
      .select("moment_id,wallet_address,edition_key,serial_number")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("moment_id", ids.slice(i, i + READ_CHUNK))
    if (error) return { rows, complete, error: `wmc read: ${error.message}` }
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
      .select("external_id,tier,player_name,team_name,set_name,circulation_count,thumbnail_url")
      .eq("collection_id", CANDY_MLB_UUID)
      .in("external_id", keys.slice(i, i + READ_CHUNK))
    if (error) return { rows, complete, error: `editions read: ${error.message}` }
    for (const e of (data ?? []) as EditionLabels[]) if (e.thumbnail_url) complete.set(e.external_id, e)
  }
  return { rows, complete, error: null }
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
  hydrate_fail_reasons: Record<string, number>
  hydrate_fetches: number
  hydrate_unverified_groups: number
  /** metadata fetches retried after every gateway answered HTTP 429 (2026-11-09) */
  hydrate_rate_limit_retries: number
  // 2026-11-09 10:20 AM PT: one fetch per edition did NOT group in production (7,121 requests
  // for 6,491 cards). A small sample of what DAS actually returns for an unhydrated asset, so
  // the grouping key can be fixed from evidence, not from the on-chain name we expected.
  unhydrated_sample: Array<{ id: string; name: string | null; json_uri: string | null; group: string; content_keys: string[] }>
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
    hydrated_fetched: 0, hydrated_reused: 0, unhydrated_skipped: 0, wmc_repointed: 0, hydrate_fail_reasons: {}, hydrate_fetches: 0, hydrate_unverified_groups: 0, hydrate_rate_limit_retries: 0, unhydrated_sample: [],
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
  let fetchAttempts = 0
  let fetchFailures = 0
  const breakerOpen = () => fetchAttempts >= BREAKER_MIN_ATTEMPTS && fetchFailures / fetchAttempts > BREAKER_FAIL_SHARE
  for (const c of (queue ?? []) as Array<{ address: string; name: string; census_page: number; census_cursor: string | null; census_walk_started_at: string | null }>) {
    if (now() > deadline) break
    const rep: CollectionCensusReport = { address: c.address, name: c.name, pages: 0, cards: 0, wmc_inserted: 0, editions_inserted: 0, hydrated_fetched: 0, hydrated_reused: 0, unhydrated_skipped: 0, wmc_repointed: 0, completed: false, error: null }
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
    let skippedThisWalk = 0
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
      // Existing holdings for every card on the page: drives REUSE and REPOINT.
      const ex = await readExisting(db, items.map((a) => a.id).filter(Boolean))
      if (ex.error) { rep.error = `page ${page}: ${ex.error}`; break }
      const reused: Array<{ asset: DasAsset; ed: EditionLabels; serial: number | null }> = []
      const toFetch: DasAsset[] = []
      const ready: DasAsset[] = []
      for (const a of items) {
        if (!isUnhydrated(a) || isBurnt(a)) { ready.push(a); continue }
        const known = (ex.rows.get(a.id) ?? []).find((r) => ex.complete.has(r.edition_key))
        if (known) reused.push({ asset: a, ed: ex.complete.get(known.edition_key)!, serial: known.serial })
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
      if (!(fetched.failed[0]?.reason === "breaker open")) {
        fetchAttempts += toFetch.length
        fetchFailures += fetched.failed.length
      }
      rep.hydrated_reused += reused.length
      rep.hydrated_fetched += fetched.hydrated.length
      rep.unhydrated_skipped += fetched.failed.length
      skippedThisWalk += fetched.failed.length
      const cards = [...ready, ...fetched.hydrated].filter((a) => !isPack(a) && !isBurnt(a) && candySetForAsset(a) !== null)
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
      // REPOINT the owner's existing row when it names a different edition; the rest stay insert-only.
      const repoint = attributed.rows.filter((r) => (ex.rows.get(String(r.moment_id)) ?? []).some((e) => e.wallet === r.wallet_address && e.edition_key !== r.edition_key))
      const repointSet = new Set(repoint)
      const insertOnly = attributed.rows.filter((r) => !repointSet.has(r))
      for (let i = 0; i < insertOnly.length && !failed; i += WRITE_CHUNK) {
        const { data, error } = await db.from("wallet_moments_cache")
          .upsert(insertOnly.slice(i, i + WRITE_CHUNK), { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: true })
          .select("moment_id")
        if (error) failed = `wallet_moments_cache: ${error.message}`
        else {
          rep.wmc_inserted += data?.length ?? 0
          for (const row of (data ?? []) as Array<{ moment_id: string }>) inserted.add(String(row.moment_id))
        }
      }
      for (let i = 0; i < repoint.length && !failed; i += WRITE_CHUNK) {
        const { data, error } = await db.from("wallet_moments_cache")
          .upsert(repoint.slice(i, i + WRITE_CHUNK), { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: false })
          .select("moment_id")
        if (error) failed = `wallet_moments_cache repoint: ${error.message}`
        else rep.wmc_repointed += data?.length ?? 0
      }
      if (failed) { rep.error = `page ${page}: ${failed}`; break }

      rep.pages++
      rep.cards += cards.length + reused.length
      cardsThisWalk += cards.length + reused.length
      const done = items.length < PAGE_LIMIT
      // last_census_items is the walk's card count only when the whole walk ran in this
      // run; a walk resumed across runs reports NULL (unknown), never a partial count.
      const patch = done
        ? { census_page: 1, census_cursor: null, census_walk_started_at: null, last_census_at: nowIso, last_census_items: startedThisRun && skippedThisWalk === 0 ? cardsThisWalk : null, last_census_error: null }
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
    out.hydrated_fetched += rep.hydrated_fetched
    out.hydrated_reused += rep.hydrated_reused
    out.unhydrated_skipped += rep.unhydrated_skipped
    out.wmc_repointed += rep.wmc_repointed
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
