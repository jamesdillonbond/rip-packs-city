// compute-allday-pack-ev v11 — supply-weighted (circulation) per-edition EV, read from Dapper Atlas.
//
// v9 (2026-07-18, reconciled into the repo 2026-07-25): also persist typical_ev
// (the weighted-MEDIAN "Typical Pull EV" that compute_pack_ev_per_edition_weighted
// already returns as typical_pull_ev) alongside gross_ev, bringing AllDay to
// parity with the TopShot writer (Actual EV vs Typical Pull).
// pack_ev_history.typical_ev + the read stack (mv_pack_ev_latest / pack_table_rows)
// already carry the column; this just fills it. Null-guarded — worst case NULL,
// which is the pre-v9 behaviour.
//
// NOTE (repo↔prod): v9 was deployed via the Supabase MCP on 2026-07-18 but the
// repo copy stayed at v8, and the 2026-07-20 _shared rewire (fb7eb0f2) refactored
// that v8 body — so the repo was simultaneously ahead (shared module) and behind
// (no typical_ev) production, and deploying it would have silently dropped a
// shipped display. Reconciled 2026-07-25. Revert: remove the typical_ev field
// from the evRows push.
//
// v7 wrote pool rows with drop_weight=1 and called compute_pack_ev_from_pool,
// a top-10%-trimmed EQUAL-WEIGHT mean(fmv) x slots. For AllDay chance/grail
// packs (pools of many low-supply rares) that badly OVER-states EV (e.g. Grail
// Seeker equal-weight ~$51 vs realized ~$2.19). Dapper does NOT populate
// per-tier packOdds for AllDay (pack_odds_sample has been {} every run), so the
// authoritative signal is SUPPLY: pull probability of an edition is ~ its share
// of minted supply. v8 sets drop_weight = orig_drop_weight = circulation share
// (normalized per-dist to (0,1] so it fits pack_drop_pool.drop_weight numeric(8,6);
// the weighted mean sum(w*fmv)/sum(w) is scale-invariant so proportions are what
// matter) and calls compute_pack_ev_per_edition_weighted, matching the already-
// circulation-weighted v_allday_pack_realized_ev view.
// Revert: restore drop_weight:1 + compute_pack_ev_from_pool (v7).
//
// v11 (2026-11-18 PT) — STUDIO → ATLAS. The Studio Platform GraphQL this read
// (searchDistributions, byProductID "AllDay") has answered HTTP 530 since 11-17
// 4:23 PM PT. Every field it consumed is now read from Dapper Atlas
// (../_shared/atlas-distributions.ts, field map in its header):
//   uuid/id/title/numberOfPackSlots/totalSupply/availableSupply/price
//       ← DistributionService/SearchDistributions {product:"nfl", limit, offset}
//   editionIds (the pool)
//       ← DistributionService/GetDistributionEditions {product:"nfl", distributionId}
//         (full pool, all pages; nfl 7148 → 616 = the 616-row Studio pool)
// Same tables, same columns, same RPC. Three deliberate differences, all honesty:
//   · the cursor is an OFFSET (Atlas pages by limit/offset); a leftover opaque
//     Studio cursor restarts the walk at 0 and is reported (extra.cursor_reset).
//   · a distribution whose pool read fails is skipped (no pool write, no EV row)
//     and FAILS the run with the HTTP status in the error, so the next tick re-reads
//     the same page (resolveCursor only continues from an ok run).
//   · a missing supply count is unknown → total_unopened/depletion_pct NULL (was
//     `?? 0` = "100 % sold"); a missing price or slot count skips the EV row
//     (counted) instead of pricing the pack at $0 / 1 slot.
//
// v12 (2026-11-23 PT) — Atlas sends no `price` on ~1,600 older distributions
// (slots are sent). v11 skipped them all, so their 11-16/17 EV froze as latest
// (pack-EV stale-3d 184 → 1,887). The newest price this lane recorded for the
// distribution is now carried forward (a retail price is fixed at release); with
// none recorded the row is still skipped. Counters split: nodes_price_unknown /
// nodes_slots_unknown / nodes_price_carried. Revert: restore v11 (git history).
// pool_source stays 'gql': it is the LANE label readers key on (refresh_atlas_pack_ev
// / refresh_container_pack_ev select pool_source='atlas' rows and must NOT start
// pricing All Day pools), not the host the pool was read from.
// Revert: restore v10 (git history) — but its upstream is dead.
//
// Flow:
//   1. Resolve the offset cursor from the last successful pipeline_runs row
//   2. Fetch one page of AllDay distributions from Atlas SearchDistributions
//   3. Read each distribution's pool from Atlas GetDistributionEditions (paced)
//   4. Batch lookup editions (chunked .in, incl circulation_count) + FMV
//   5. For each distribution: upsert-then-prune pool rows (per-dist circ share)
//   6. After ALL pool writes complete: call compute_pack_ev_per_edition_weighted per dist
//   7. Collect evRows, bulk insert to pack_ev_history

import { createClient } from "@supabase/supabase-js"
import { supplyWeightPool, computeDepletionPct, latestRecordedPrices, resolvePackPrice } from "../_shared/pack-ev-supply-weighted.ts"
import {
  type AtlasDist,
  defaultAtlasDeps,
  fetchDistributionEditionIds,
  parseOffsetCursor,
  searchDistributionsPage,
  supplyOf,
} from "../_shared/atlas-distributions.ts"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const ATLAS_PRODUCT = "nfl" as const
// Studio served 40 distributions a page; Atlas would serve 100, but each one costs
// at least one GetDistributionEditions call, and Atlas's Cloudflare is burst-
// sensitive — keep the per-run request count where the Studio lane had it.
const PAGE_LIMIT = 40
const FUNCTION_VERSION = 12
const EXTERNAL_ID_CHUNK = 500
const FMV_ID_CHUNK = 500 // get_fmv_for_editions: one row per id, so 500 ids can never reach PostgREST max-rows (1000)

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

/** A distribution plus the pool Atlas returned for it — the Studio node's shape, re-sourced. */
interface DistNode extends AtlasDist {
  editionIds: string[]
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null
  extra: Record<string, unknown>
  cursorBefore?: string | null; cursorAfter?: string | null
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "compute-allday-pack-ev",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nfl-all-day",
      p_cursor_before: args.cursorBefore ?? null,
      p_cursor_after: args.cursorAfter ?? null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

async function resolveCursor(explicit: string | null): Promise<string | null> {
  if (explicit === "reset") return null
  if (explicit != null && explicit !== "") return explicit
  const { data, error } = await supabase
    .from("pipeline_runs")
    .select("cursor_after, extra")
    .eq("pipeline", "compute-allday-pack-ev")
    .eq("ok", true)
    .order("started_at", { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return null
  // deno-lint-ignore no-explicit-any
  const row = data[0] as any
  const hasNext = row.extra?.has_next_page === true
  if (!hasNext) return null
  return row.cursor_after ?? null
}

/** The terminal row's error: every failure class, counted, with the first messages (they carry "HTTP <status>"). */
function runErrorText(poolReadErrors: string[], poolWriteErrors: string[], malformed: number): string | null {
  const parts: string[] = []
  if (poolReadErrors.length) parts.push(`${poolReadErrors.length} pool read error(s): ${poolReadErrors.slice(0, 2).join(" | ")}`)
  if (poolWriteErrors.length) parts.push(`${poolWriteErrors.length} pool write error(s): ${poolWriteErrors.slice(0, 2).join(" | ")}`)
  if (malformed) parts.push(`${malformed} Atlas distribution row(s) without uuid/id`)
  return parts.length ? parts.join(" ; ").slice(0, 500) : null
}

async function runBackgroundWork(startedAtIso: string, started: number, cursor: string | null) {
  try {
    const atlas = defaultAtlasDeps()
    const { offset, reset: cursorReset } = parseOffsetCursor(cursor)
    const page = await searchDistributionsPage(ATLAS_PRODUCT, offset, PAGE_LIMIT, atlas)
    let atlasRequests = page.requests

    if (!page.ok) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `atlas: ${page.error}`,
        extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas", atlas_requests: atlasRequests, offset, cursor_reset: cursorReset },
        cursorBefore: cursor,
      })
      return
    }

    const nextOffset = offset + page.rawCount
    const hasNextPage = page.rawCount > 0 && nextOffset < page.totalCount
    const endCursor: string | null = String(nextOffset)

    if (page.rawCount === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          message: "empty page", elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, has_next_page: false,
          source: "atlas", atlas_requests: atlasRequests, offset, total_count: page.totalCount, cursor_reset: cursorReset,
        },
        cursorBefore: cursor, cursorAfter: endCursor,
      })
      return
    }

    // === Phase 0: each distribution's pool (Studio's editionIds), one at a time ===
    // A failed pool read SKIPS that distribution (no pool write, no EV row) and
    // fails the run at the terminal row; it is never treated as an empty pool.
    const nodes: DistNode[] = []
    const poolReadErrors: string[] = []
    for (const d of page.dists) {
      await atlas.sleep(atlas.gapMs)
      const pool = await fetchDistributionEditionIds(ATLAS_PRODUCT, d.id, atlas)
      atlasRequests += pool.requests
      if (!pool.ok) { poolReadErrors.push(pool.error); continue }
      nodes.push({ ...d, editionIds: pool.editionIds })
    }

    // === Phase 1: bulk edition + FMV lookups ===
    const allExternalIds = new Set<string>()
    for (const n of nodes) for (const eid of n.editionIds ?? []) allExternalIds.add(String(eid))

    const editionByExternalId = new Map<string, { id: string; tier: string | null; circ: number | null }>()
    const externalIdList = Array.from(allExternalIds)
    for (let i = 0; i < externalIdList.length; i += EXTERNAL_ID_CHUNK) {
      const chunk = externalIdList.slice(i, i + EXTERNAL_ID_CHUNK)
      const { data: rows, error } = await supabase
        .from("editions")
        .select("id, external_id, tier, circulation_count")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("external_id", chunk)
      if (error) throw new Error(`editions chunk: ${error.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (rows ?? []) as any[]) {
        editionByExternalId.set(String(r.external_id), { id: r.id, tier: r.tier, circ: r.circulation_count })
      }
    }

    const editionUuids = Array.from(editionByExternalId.values()).map(v => v.id)
    const fmvByEditionId = new Map<string, number>()
    // 2026-09-22 (v10): CHUNKED. get_fmv_for_editions is a set-returning RPC, and
    // PostgREST clamps every RPC result to max-rows = 1000. One call over the whole
    // page's editions (1,488 on 09-22) silently returned exactly 1,000 rows, so ~460
    // priced editions read as "no FMV": 82 of 144 runs over 3 days logged
    // editions_with_fmv = 1000 exactly, and whole distributions fell into
    // nodes_no_fmv_coverage (no EV written) or got an EV over a partial pool.
    // The function returns at most one row per edition id, so a 500-id chunk can
    // never reach the cap.
    for (let i = 0; i < editionUuids.length; i += FMV_ID_CHUNK) {
      const { data: fmvRows, error: fmvErr } = await supabase.rpc("get_fmv_for_editions", {
        p_collection_id: ALLDAY_COLLECTION_ID,
        p_edition_ids: editionUuids.slice(i, i + FMV_ID_CHUNK),
      })
      if (fmvErr) throw new Error(`get_fmv_for_editions: ${fmvErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (fmvRows ?? []) as any[]) {
        if (r.fmv_usd != null) fmvByEditionId.set(String(r.edition_id), Number(r.fmv_usd))
      }
    }

    // === Phase 2: build pool rows per eligible distribution ===
    const counters = {
      nodes_processed: 0, nodes_no_editions: 0, nodes_no_fmv_coverage: 0,
      pool_rows_written: 0, pool_write_errors: 0, ev_rows_written: 0, single_edition_packs: 0,
      rpc_not_ok: 0, rpc_errors: 0, weighted_count: 0,
      nodes_pool_read_failed: poolReadErrors.length, nodes_price_or_slots_unknown: 0, nodes_supply_unknown: 0,
      // v12: the combined counter above is kept for its readers; these split it.
      nodes_price_unknown: 0, nodes_slots_unknown: 0, nodes_price_carried: 0, price_carry_read_failed: 0,
      malformed_distributions: page.malformed,
    }
    // One stamp for every pool row this run writes — the prune in Phase 3 keys on it.
    const runStamp = new Date().toISOString()
    const poolRowsByDist: Record<string, Array<Record<string, unknown>>> = {}
    const distMeta: Record<string, { node: DistNode; editionsWithFmv: number; editionCount: number }> = {}

    for (const node of nodes) {
      counters.nodes_processed++
      const externalIds = (node.editionIds ?? []).map(String)
      if (externalIds.length === 0) { counters.nodes_no_editions++; continue }

      const pooledEditions: Array<{ external_id: string; edition_id: string; fmv: number | null; circ: number | null }> = []
      for (const ext of externalIds) {
        const ed = editionByExternalId.get(ext)
        if (!ed) continue
        pooledEditions.push({
          external_id: ext, edition_id: ed.id,
          fmv: fmvByEditionId.get(ed.id) ?? null,
          circ: ed.circ,
        })
      }

      const editionCount = pooledEditions.length
      const editionsWithFmv = pooledEditions.filter(p => p.fmv != null).length
      if (editionCount === 0) { counters.nodes_no_editions++; continue }
      if (editionsWithFmv === 0) { counters.nodes_no_fmv_coverage++; continue }
      if (editionCount === 1) counters.single_edition_packs++

      const distId = String(node.id)
      distMeta[distId] = { node, editionsWithFmv, editionCount }

      // Supply-weighted: pull probability ~ minted supply share. Normalize per-dist
      // to (0,1] so it fits pack_drop_pool.drop_weight numeric(8,6) (max < 100);
      // the weighted-mean EV is scale-invariant so only the ratios matter.
      // supplyWeightPool (../_shared) is the pinned, unit-tested copy of this math.
      const weights = supplyWeightPool(pooledEditions.map(p => p.circ))
      poolRowsByDist[distId] = pooledEditions.map((p, i) => {
        const w = weights[i]
        return {
          collection_id: ALLDAY_COLLECTION_ID,
          dist_id: distId,
          edition_id: p.edition_id,
          edition_flow_id: p.external_id,
          drop_weight: w, orig_drop_weight: w, slot_name: "default", pool_source: "gql",
          last_refreshed_at: runStamp,
        }
      })
    }

    // === Phase 3: delete-then-insert pool rows per distribution ===
    // Must complete before RPC calls since the weighted EV RPC reads pack_drop_pool.
    // R123 (2026-09-20): this was DELETE the distribution's pool, then INSERT with
    // the error discarded (`if (!ie)`) and the delete's error never read — a
    // rejected insert left the distribution with NO pool (the weighted EV RPC then
    // read nothing) on a run row that said ok=true. Now: UPSERT on the PK
    // (collection_id, dist_id, edition_id, slot_name) first, then PRUNE the rows
    // of that distribution this run did not write. A rejected upsert leaves the
    // old pool intact and skips the prune; every error is counted and fails the
    // run at the terminal row.
    const poolWriteErrors: string[] = []
    for (const [distId, rows] of Object.entries(poolRowsByDist)) {
      let distFailed = false
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const { error: ie } = await supabase.from("pack_drop_pool")
          .upsert(chunk, { onConflict: "collection_id,dist_id,edition_id,slot_name" })
        if (ie) { distFailed = true; poolWriteErrors.push(`pool upsert ${distId}: ${ie.message}`); break }
        counters.pool_rows_written += chunk.length
      }
      if (distFailed) continue
      // 2026-09-22 (v10): prune by the RUN STAMP, not by a NOT IN (<every kept id>)
      // list. That list rides in the URL, and a 779-edition pool (dist 5349) made the
      // DELETE request too long — "Bad Request" on every run since R123, 75 of 97
      // runs failed. Every row this run wrote carries last_refreshed_at = runStamp
      // (the upsert overwrites it), so "older than runStamp" is exactly "not written
      // this run", in a constant-size request.
      const { error: de } = await supabase.from("pack_drop_pool").delete()
        .eq("collection_id", ALLDAY_COLLECTION_ID).eq("dist_id", distId)
        .lt("last_refreshed_at", runStamp)
      if (de) poolWriteErrors.push(`pool prune ${distId}: ${de.message}`)
    }
    counters.pool_write_errors = poolWriteErrors.length

    // === Phase 3b (v12): carry forward the retail price Atlas omits ===
    // Atlas sends no `price` on older distributions (~1,600 of 3,211; measured
    // 2026-11-23). This lane recorded each one before the 11-18 Studio → Atlas move,
    // and a released pack's retail price never changes, so the newest recorded price
    // is carried (latestRecordedPrices). 40 distributions × ≤ 15 rows in 30 days stays
    // under the 1,000-row cap; ordered dist_id then newest first, so a truncated read
    // can only drop a distribution (it stays unknown), never hand it an older price.
    const priceMissing = Object.entries(distMeta)
      .filter(([, m]) => m.node.price == null && m.node.numberOfPackSlots != null)
      .map(([id]) => id)
    let carriedPrices = new Map<string, number>()
    if (priceMissing.length > 0) {
      const { data: priced, error: pe } = await supabase.from("pack_ev_history")
        .select("dist_id, pack_price")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("dist_id", priceMissing)
        .not("pack_price", "is", null)
        .gte("snapshotted_at", new Date(Date.now() - 30 * 86_400_000).toISOString())
        .order("dist_id", { ascending: true })
        .order("snapshotted_at", { ascending: false })
        .limit(1000)
      if (pe) counters.price_carry_read_failed = 1 // prices stay unknown: those rows are skipped and counted
      else carriedPrices = latestRecordedPrices((priced ?? []) as { dist_id: string; pack_price: string | number | null }[])
    }

    // === Phase 4: compute supply-weighted EV per distribution via RPC ===
    const evRows: Array<Record<string, unknown>> = []
    for (const [distId, meta] of Object.entries(distMeta)) {
      const { node } = meta
      // Atlas omits a field it does not know. An unknown slot count, or a price that is
      // neither sent nor recorded, is not $0 / 1 slot — the EV row would be a
      // fabrication, so it is skipped and counted.
      const verdict = resolvePackPrice(node.price, node.numberOfPackSlots, carriedPrices.get(distId))
      if (!verdict.ok) {
        counters.nodes_price_or_slots_unknown++
        if (verdict.reason === "slots_unknown") counters.nodes_slots_unknown++
        else counters.nodes_price_unknown++
        continue
      }
      if (verdict.carried) counters.nodes_price_carried++
      const slots = verdict.slots
      const packPrice = verdict.price

      const { data: rpcResult, error: rpcErr } = await supabase.rpc("compute_pack_ev_per_edition_weighted", {
        p_collection_id: ALLDAY_COLLECTION_ID,
        p_dist_id: distId,
        p_pack_price: packPrice,
        p_slots: slots,
      })

      if (rpcErr) {
        counters.rpc_errors++
        console.log(`[compute-allday-pack-ev] rpc err dist=${distId}: ${rpcErr.message}`)
        continue
      }
      // deno-lint-ignore no-explicit-any
      const ev = rpcResult as any
      if (!ev || ev.ok !== true) {
        counters.rpc_not_ok++
        continue
      }
      if (ev.per_edition_weighted === true) counters.weighted_count++

      // A missing count is unknown, not 0 (`?? 0` read as "100 % sold").
      const supply = supplyOf(node)
      if (!supply.read) counters.nodes_supply_unknown++
      const depletionPct = supply.read ? computeDepletionPct(supply.total, supply.available) : null

      evRows.push({
        pack_listing_id: node.uuid,
        collection_id: ALLDAY_COLLECTION_ID,
        dist_id: distId,
        pack_name: node.title,
        pack_price: packPrice,
        gross_ev: Number(ev.gross_ev),
        pack_ev: Number(ev.pack_ev),
        typical_ev: ev.typical_pull_ev != null ? Number(ev.typical_pull_ev) : null,
        is_positive_ev: Boolean(ev.is_positive_ev),
        value_ratio: ev.value_ratio != null ? Number(ev.value_ratio) : null,
        fmv_coverage_pct: Number(ev.fmv_coverage_pct),
        edition_count: Math.min(Number(ev.edition_count), 32767),
        total_unopened: supply.read ? supply.available : null,
        depletion_pct: depletionPct,
      })
    }

    // === Phase 5: bulk insert EV history ===
    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (!evErr) counters.ev_rows_written = evRows.length
      else {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: page.rawCount, rowsWritten: 0, rowsSkipped: nodes.length,
          ok: false, error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas", atlas_requests: atlasRequests },
          cursorBefore: cursor, cursorAfter: endCursor,
        })
        return
      }
    }

    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: page.rawCount,
      rowsWritten: counters.ev_rows_written,
      rowsSkipped: counters.nodes_no_editions + counters.nodes_no_fmv_coverage + counters.rpc_not_ok + counters.rpc_errors +
        counters.nodes_pool_read_failed + counters.nodes_price_or_slots_unknown,
      // ok = every distribution on the page was read AND written. A pool that could
      // not be read, a malformed Atlas row, or a failed pool write fails the run
      // (the next tick re-reads this page: resolveCursor continues only from ok runs).
      ok: poolWriteErrors.length === 0 && poolReadErrors.length === 0 && page.malformed === 0,
      error: runErrorText(poolReadErrors, poolWriteErrors, page.malformed),
      extra: {
        ...counters,
        editions_resolved: editionByExternalId.size,
        editions_with_fmv: fmvByEditionId.size,
        editions_requested: allExternalIds.size,
        elapsed_ms: elapsed,
        function_version: FUNCTION_VERSION,
        ev_method: "circulation_weighted",
        has_next_page: hasNextPage,
        source: "atlas",
        atlas_requests: atlasRequests,
        offset,
        total_count: page.totalCount,
        cursor_reset: cursorReset,
        pool_read_errors_sample: poolReadErrors.slice(0, 3),
      },
      cursorBefore: cursor, cursorAfter: endCursor,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-allday-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas" },
      cursorBefore: cursor,
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const url = new URL(req.url)
  const explicitCursor = url.searchParams.get("cursor")
  const cursor = await resolveCursor(explicitCursor)
  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runBackgroundWork(startedAtIso, started, cursor)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch((e) => console.log(`waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      cursor_before: cursor,
      started_at: startedAtIso,
      note: "Real results will appear in pipeline_runs within ~40s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
