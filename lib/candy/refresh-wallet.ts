// lib/candy/refresh-wallet.ts
//
// One Candy (Solana) wallet, read live from chain and written to
// wallet_moments_cache — the walk behind a pasted Candy address (2026-11-08).
//
// Why: the Collection tab answers a Candy search from wallet_moments_cache, which
// only the DAILY census (5:10 PM PT) refreshes. A collector who bought, opened a
// pack or moved cards since then searched their own address and saw the
// yesterday-shaped answer — or nothing at all for a wallet created since. Two callers
// (2026-11-08): the anonymous /api/candy/wallet-refresh (a pasted address) and the
// bearer-gated /api/wallet-backfill-candy (a signed-in user SAVES a wallet).
//
// What it does, in order:
//   1. getAssetsByOwner, every page, filtered to the Candy sets we track
//      (lib/chains/solana/candy-sets.ts), burnt cards and pack assets dropped.
//   2. Cards this wallet has LISTED on Magic Eden sit in the escrow, so step 1
//      cannot see them (#145): each is re-read from DAS and written under the
//      wallet only if the escrow still holds it.
//   3. Upsert every row with last_seen_at = now. Editions this wallet holds that the
//      catalog has not seen yet (a new drop, or a set before its first census) are
//      INSERTED — never updated, so an existing edition (above all the 125 Base
//      editions, whose set/tier the DB owns) is untouched — so the binder can name the
//      card today instead of after tonight's census. Then the metadata denorm.
//   4. Only when the walk is COMPLETE (every page read, every escrow card read,
//      every write landed) and `retire` is set: the wallet's Candy rows this walk
//      did not touch are cards it no longer holds — retired by
//      candy_retire_wallet_unseen(); then purge_candy_wmc_ghost_rows_for() drops the
//      previous owner's row of any card this wallet now holds (only the cards written). An incomplete walk
//      retires NOTHING: it fails open (CLAUDE.md, "an ADD-ONLY refresh never
//      retires what its source stopped returning … fail OPEN with no clean walk").

import { getAssetsByOwner, getAsset, getAssetBatch, type DasAsset } from "@/lib/chains/solana/das"
import { MAGIC_EDEN_SOLANA_ESCROW, listedMintsInEscrowForSeller } from "@/lib/chains/solana/escrow"
import { isBurnt, isPack, normalizeSerial, normalizeEdition, CANDY_MLB_UUID } from "@/lib/chains/solana/normalize"
import { isUnhydrated } from "@/lib/chains/solana/hydrate"
import { isCandySetAsset, CANDY_COLLECTION_AUTHORITIES } from "@/lib/chains/solana/candy-sets"
import { loadCandyCollections } from "@/lib/candy/collections"
import { purgeCandyGhostsFor } from "@/lib/candy/ghost-purge"

const UPSERT_CHUNK = 500
const PAGE_LIMIT = 1000
// A wallet holding more than 20,000 assets of ANY collection is not a collector
// we can read in one request; the walk stops and reports itself incomplete.
const MAX_PAGES = 20
const ESCROW_READ_CONCURRENCY = 2

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface CandyWalletRefreshResult {
  /** Every page read, every escrow card read, every write landed. */
  complete: boolean
  found: number
  written: number
  escrow_listed: number
  escrow_listed_written: number
  escrow_listed_stale: number
  escrow_listed_capped: boolean
  escrow_listed_error: string | null
  pages: number
  write_errors: string[]
  /** Set when the owner walk itself failed (DAS error, page cap, deadline). */
  walk_error: string | null
  /** candy_collections rows registered for this walk; catalog_error when that read failed. */
  catalog_collections: number
  catalog_error: string | null
  /** Catalog rows inserted for editions not seen before (insert-only). */
  editions_inserted: number
  editions_error: string | null
  /**
   * Candy collectibles in this wallet that RPC does not catalogue (2021–2025 ICONs, pins,
   * Digi-Casts… — any Core collection whose update authority is Candy's). Counted so the
   * tab can say they exist instead of letting "0 moments" read as "holds nothing".
   * null when the check could not run.
   */
  other_candy: { items: number; collections: Array<{ name: string | null; items: number }> } | null
  other_candy_error: string | null
  /**
   * 2026-11-12 (#246 source): cards DAS returned WITHOUT metadata. Keyed from the bare name they fabricate
   * a label-less edition, so they are never written: the existing row (if any) only has last_seen_at
   * touched — keeping it out of retirement under the key it already has — and the census fills it later.
   */
  unhydrated_kept: number
  /** Rows retired / ghost rows purged; null when retirement did not run. */
  retired: number | null
  ghosts_purged: number | null
  retire_error: string | null
}

export async function refreshCandyWallet(
  db: Db,
  wallet: string,
  opts: { retire?: boolean; deadlineAt?: number } = {},
): Promise<CandyWalletRefreshResult> {
  const deadlineAt = opts.deadlineAt ?? Number.POSITIVE_INFINITY
  const startedAt = new Date().toISOString()
  const r: CandyWalletRefreshResult = {
    complete: false,
    found: 0,
    written: 0,
    escrow_listed: 0,
    escrow_listed_written: 0,
    escrow_listed_stale: 0,
    escrow_listed_capped: false,
    escrow_listed_error: null,
    pages: 0,
    write_errors: [],
    walk_error: null,
    editions_inserted: 0,
    editions_error: null,
    catalog_collections: 0,
    catalog_error: null,
    other_candy: null,
    other_candy_error: null,
    unhydrated_kept: 0,
    retired: null,
    ghosts_purged: null,
    retire_error: null,
  }
  // Every catalogued Candy collection (candy_collections), registered with the normalizer
  // before the walk so a wallet's 2021–2025 ICONs, DC, pins… are written, not just counted.
  const catalog = await loadCandyCollections(db)
  r.catalog_collections = catalog.sets.length
  r.catalog_error = catalog.error
  const seen = new Set<string>()
  const editionsByKey = new Map<string, Record<string, unknown>>()
  // Untracked Core collections in this wallet → live (non-burnt) asset count.
  const otherCollections = new Map<string, number>()

  const write = async (rows: Array<Record<string, unknown>>, label: string): Promise<number> => {
    let n = 0
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + UPSERT_CHUNK)
      const { data, error } = await db
        .from("wallet_moments_cache")
        .upsert(chunk, { onConflict: "wallet_address,collection_id,moment_id" })
        .select("moment_id")
      if (error) r.write_errors.push(`${label}: ${error.message}`)
      else n += data?.length ?? chunk.length
    }
    return n
  }
  // An owned card DAS returned without metadata: touch its EXISTING row (any key) so retirement keeps it;
  // never write it under a name-only key. A failed touch is a write error → the walk is incomplete → no retire.
  const keepUnhydrated = async (ids: string[], now: string): Promise<void> => {
    if (!ids.length) return
    for (const id of ids) seen.add(id)
    r.unhydrated_kept += ids.length
    for (let i = 0; i < ids.length; i += UPSERT_CHUNK) {
      const { error } = await db
        .from("wallet_moments_cache")
        .update({ last_seen_at: now })
        .eq("collection_id", CANDY_MLB_UUID)
        .eq("wallet_address", wallet)
        .in("moment_id", ids.slice(i, i + UPSERT_CHUNK))
      if (error) r.write_errors.push(`wallet_moments_cache (keep unhydrated): ${error.message}`)
    }
  }

  // 1. Owner walk.
  try {
    let page = 1
    for (; page <= MAX_PAGES; page++) {
      if (Date.now() > deadlineAt) throw new Error("time budget reached before the last page")
      const res = await getAssetsByOwner(wallet, page, PAGE_LIMIT)
      const items = (res?.items ?? []) as DasAsset[]
      r.pages = page
      const now = new Date().toISOString()
      const candyLive = items
        .filter(isCandySetAsset)
        .filter((a) => !isBurnt(a))
      await keepUnhydrated(candyLive.filter((a) => isUnhydrated(a) && a.id).map((a) => a.id), now)
      const cards = candyLive
        .filter((a) => !isUnhydrated(a))
        .filter((a) => !isPack(a))
      for (const a of items) {
        if (isCandySetAsset(a) || isBurnt(a)) continue
        const coll = a.grouping?.find((g) => g.group_key === "collection")?.group_value
        if (coll) otherCollections.set(coll, (otherCollections.get(coll) ?? 0) + 1)
      }
      for (const a of cards) {
        const ed = normalizeEdition(a) as unknown as Record<string, unknown>
        const key = String(ed.external_id ?? "")
        if (key && !editionsByKey.has(key)) editionsByKey.set(key, ed)
      }
      const rows = cards
        .map((a) => {
          const s = normalizeSerial(a)
          if (!s.moment_id) return null
          // Stamp the QUERIED wallet so a stale DAS owner field cannot misattribute a row.
          return { ...s, wallet_address: wallet, last_seen_at: now }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
      for (const row of rows) seen.add(String(row.moment_id))
      r.found += rows.length
      r.written += await write(rows, "wallet_moments_cache")
      if (items.length < PAGE_LIMIT) break
    }
    if (page > MAX_PAGES) throw new Error(`more than ${MAX_PAGES * PAGE_LIMIT} assets — walk stopped`)
  } catch (e) {
    r.walk_error = (e instanceof Error ? e.message : String(e)).slice(0, 300)
  }

  // 2. Escrow-held listed cards (#145).
  const listed = await listedMintsInEscrowForSeller(db, wallet)
  r.escrow_listed_capped = listed.capped
  if (listed.error) {
    r.escrow_listed_error = listed.error
  } else {
    const now = new Date().toISOString()
    const escrowRows: Array<Record<string, unknown>> = []
    const todo = listed.mints.filter((m) => !seen.has(m))
    let next = 0
    let budgetHit = false
    const worker = async () => {
      while (next < todo.length) {
        if (Date.now() > deadlineAt) { budgetHit = true; return }
        const mint = todo[next++]
        let a: DasAsset
        try {
          try {
            a = await getAsset(mint)
          } catch (e) {
            if (!/HTTP 429/.test(e instanceof Error ? e.message : String(e))) throw e
            await new Promise((res) => setTimeout(res, 1500))
            a = await getAsset(mint)
          }
        } catch (e) {
          r.escrow_listed_error = `getAsset ${mint}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200)
          continue
        }
        if (a?.ownership?.owner !== MAGIC_EDEN_SOLANA_ESCROW) { r.escrow_listed_stale++; continue }
        if (!isCandySetAsset(a) || isBurnt(a)) continue
        if (isUnhydrated(a)) { await keepUnhydrated([mint], now); continue }
        if (isPack(a)) continue
        const s = normalizeSerial(a)
        if (!s.moment_id) continue
        escrowRows.push({ ...s, wallet_address: wallet, last_seen_at: now })
        seen.add(String(s.moment_id))
      }
    }
    await Promise.all(Array.from({ length: ESCROW_READ_CONCURRENCY }, worker))
    if (budgetHit || r.escrow_listed_capped) {
      r.escrow_listed_error = r.escrow_listed_error ?? `incomplete: ${budgetHit ? "time budget reached" : `more than ${todo.length} active listings`}`
    }
    r.escrow_listed = escrowRows.length
    r.found += escrowRows.length
    r.escrow_listed_written = await write(escrowRows, "wallet_moments_cache (escrow-listed)")
    r.written += r.escrow_listed_written
  }

  // 3. Insert-only catalog rows for editions not seen before (non-fatal: the cards are
  // still the wallet's; they would just render unnamed until the census).
  if (editionsByKey.size > 0) {
    try {
      const keys = [...editionsByKey.keys()]
      const known = new Set<string>()
      for (let i = 0; i < keys.length; i += UPSERT_CHUNK) {
        const { data, error } = await db
          .from("editions")
          .select("external_id")
          .eq("collection_id", CANDY_MLB_UUID)
          .in("external_id", keys.slice(i, i + UPSERT_CHUNK))
        if (error) throw new Error(error.message)
        for (const row of (data ?? []) as Array<{ external_id: string }>) known.add(row.external_id)
      }
      const missing = keys.filter((k) => !known.has(k)).map((k) => editionsByKey.get(k)!)
      for (let i = 0; i < missing.length; i += UPSERT_CHUNK) {
        const chunk = missing.slice(i, i + UPSERT_CHUNK)
        const { data, error } = await db
          .from("editions")
          .upsert(chunk, { onConflict: "external_id,collection_id", ignoreDuplicates: true })
          .select("external_id")
        if (error) throw new Error(error.message)
        r.editions_inserted += data?.length ?? 0
      }
    } catch (e) {
      r.editions_error = (e instanceof Error ? e.message : String(e)).slice(0, 200)
    }
  }

  // 3b. Which of the wallet's other Core collections are Candy's (non-fatal, informational).
  if (r.walk_error === null) {
    try {
      const ids = [...otherCollections.keys()].slice(0, 1000)
      const found: Array<{ name: string | null; items: number }> = []
      let items = 0
      if (ids.length > 0 && Date.now() < deadlineAt) {
        const colls = await getAssetBatch(ids)
        for (const c of colls ?? []) {
          if (!c?.id) continue
          const auths = (c as { authorities?: Array<{ address?: string }> }).authorities ?? []
          if (!auths.some((x) => x?.address && CANDY_COLLECTION_AUTHORITIES.includes(x.address))) continue
          const n = otherCollections.get(c.id) ?? 0
          items += n
          found.push({ name: c.content?.metadata?.name ?? null, items: n })
        }
      }
      found.sort((a, b) => b.items - a.items)
      r.other_candy = { items, collections: found }
    } catch (e) {
      r.other_candy_error = (e instanceof Error ? e.message : String(e)).slice(0, 200)
    }
  }

  // 4. Metadata denorm (COALESCE-guarded; non-fatal).
  if (r.written > 0) {
    try {
      const { error } = await db.rpc("backfill_wmc_metadata_from_editions", {
        p_wallet_address: wallet,
        p_collection_id: CANDY_MLB_UUID,
      })
      if (error) console.log(`[candy-refresh-wallet] metadata denorm err: ${error.message}`)
    } catch (e) {
      console.log(`[candy-refresh-wallet] metadata denorm threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  r.complete = r.walk_error === null && r.escrow_listed_error === null && r.write_errors.length === 0

  // 5. Retire — only behind a complete walk.
  if (opts.retire && r.complete) {
    try {
      const { data, error } = await db.rpc("candy_retire_wallet_unseen", {
        p_wallet: wallet,
        p_walk_started_at: startedAt,
      })
      if (error) r.retire_error = error.message
      else r.retired = typeof data === "number" ? data : Number(data ?? 0)
      if (!error) {
        const g = await purgeCandyGhostsFor(db, seen)
        if (g.error) r.retire_error = g.error
        else r.ghosts_purged = g.purged
      }
    } catch (e) {
      r.retire_error = e instanceof Error ? e.message : String(e)
    }
  }

  return r
}
