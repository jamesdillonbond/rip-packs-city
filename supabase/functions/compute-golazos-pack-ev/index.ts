// compute-golazos-pack-ev v4 — supply-weighted (circulation) per-edition EV, distributions from Dapper Atlas.
//
// v4 (2026-11-18 PT) — STUDIO → ATLAS, WITH ONE FIELD ATLAS CANNOT SUPPLY.
// The Studio Platform GraphQL this read (searchDistributions, byProductID
// "Golazos") has answered HTTP 530 since 11-17 4:23 PM PT. Re-sourced
// (../_shared/atlas-distributions.ts, field map in its header):
//   uuid/id/title/numberOfPackSlots/totalSupply/availableSupply/price
//       ← DistributionService/SearchDistributions {product:"laliga", limit, offset}
//         (169 distributions on 11-18; dist 235 "Jornadas 1-9" carries the same
//         uuid 262cbbfb-… Studio gave it, so pack_listing_id is unchanged)
//   editionIds (the pool) ← ⚠ NOTHING ON ATLAS. For product "laliga",
//         GetDistributionEditions answers {editions:[], totalCount:"0"} for every
//         distribution probed (219, 234, 235, 238 — including ones with unopened
//         packs), and GetDistributionPackOdds / GetDistributionsByEdition are empty
//         too. Atlas holds no Golazos distribution→edition map.
// So the pool MEMBERSHIP comes from the pool Studio last confirmed, already in
// pack_drop_pool (157 of the 169 Atlas distributions have one). A distribution's
// pool is fixed when it is minted; what moves — FMV, and each edition's minted
// circulation (the weight) — is still re-read every run, and the weights are
// rewritten. What this lane does NOT do any more, and says so:
//   · it never ADDS or PRUNES a pool row (it learned nothing about membership), and
//     it leaves pack_drop_pool.last_refreshed_at at the time Studio last confirmed
//     the membership — that column keeps meaning "membership last read".
//   · a distribution with no stored pool (12 on 11-18, e.g. 294 "Lewandowski's
//     Strikers") gets NO EV row; it is counted (nodes_no_pool_source) and named
//     (no_pool_source_sample) in every run row, never priced off a guess.
// Same tables/columns/RPC otherwise. Honesty differences vs v3: a missing supply
// count is NULL (was `?? 0`), a missing price or slot count skips the EV row, and
// the cursor is an Atlas OFFSET (a leftover Studio cursor restarts at 0, reported).
// Revert: restore v3 (git history) — but its upstream is dead.
//
// v2 (2026-07-18, reconciled into the repo 2026-07-25): also persist typical_ev
// (the weighted-MEDIAN "Typical Pull EV" returned by
// compute_pack_ev_per_edition_weighted as typical_pull_ev) alongside gross_ev —
// parity with the TopShot/AllDay writers. Null-guarded; the column is already in
// pack_ev_history and the read stack (mv_pack_ev_latest / pack_table_rows).
//
// Cloned from compute-allday-pack-ev v8. LaLiga Golazos is editions-keyed like
// AllDay (editions.external_id = the studio edition id as an integer string).
// Dapper does not publish per-tier packOdds for Golazos, so EV is supply-weighted:
// an edition's pull probability ~ its share of minted circulation.
// Auth: accepts EITHER Bearer INGEST_SECRET_TOKEN (manual/CC) OR the cron gate
// (pg_cron net.http_get, mirroring compute-pinnacle-pack-ev).
// Revert: DROP the compute-golazos-pack-ev function + its cron job.

import { createClient } from "@supabase/supabase-js"
import { checkCronGate, cronGateResponse } from "../_shared/cron-gate.ts"
import { supplyWeightPool, computeDepletionPct } from "../_shared/pack-ev-supply-weighted.ts"
import {
  type AtlasDist,
  defaultAtlasDeps,
  parseOffsetCursor,
  searchDistributionsPage,
  supplyOf,
} from "../_shared/atlas-distributions.ts"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")
// Gate (2026-10-13): ../_shared/cron-gate.ts — the key (x-rpc-gate-key header or ?key=) is
// checked against the SAME Vault secret pg_cron sends, cron_gate_key('compute-golazos-pack-ev'). No env
// secret is read; a rotation is one vault.update_secret (rpc-edge-fn-deploy §0).

const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const ATLAS_PRODUCT = "laliga" as const
const PAGE_LIMIT = 40 // what Studio served per page; keeps the per-run work where it was
const FUNCTION_VERSION = 4
const EXTERNAL_ID_CHUNK = 500
const FMV_ID_CHUNK = 500 // get_fmv_for_editions: one row per id, so 500 ids can never reach PostgREST max-rows (1000)
const POOL_READ_PAGE = 1000 // PostgREST max-rows; the stored-pool read pages below it

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

/** One stored pool row: the membership Studio last confirmed for a distribution. */
interface StoredPoolRow {
  edition_id: string
  edition_flow_id: string
  slot_name: string
  last_refreshed_at: string | null
}

/** A distribution plus its stored pool — the Studio node's shape, re-sourced. */
interface DistNode extends AtlasDist {
  pool: StoredPoolRow[]
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
      p_pipeline: "compute-golazos-pack-ev",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "laliga-golazos",
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
    .eq("pipeline", "compute-golazos-pack-ev")
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

/**
 * The stored pool of one distribution, every row (paged under PostgREST's
 * max-rows on a unique order key). Throws on a read error: an unread pool is not
 * an empty one.
 */
async function readStoredPool(distId: string): Promise<StoredPoolRow[]> {
  const out: StoredPoolRow[] = []
  for (let from = 0; ; from += POOL_READ_PAGE) {
    const { data, error } = await supabase
      .from("pack_drop_pool")
      .select("edition_id, edition_flow_id, slot_name, last_refreshed_at")
      .eq("collection_id", GOLAZOS_COLLECTION_ID)
      .eq("dist_id", distId)
      .order("edition_id", { ascending: true })
      .order("slot_name", { ascending: true })
      .range(from, from + POOL_READ_PAGE - 1)
    if (error) throw new Error(`pack_drop_pool read ${distId}: ${error.message}`)
    // deno-lint-ignore no-explicit-any
    const rows = (data ?? []) as any[]
    for (const r of rows) {
      if (r.edition_id == null || r.edition_flow_id == null) continue
      out.push({
        edition_id: String(r.edition_id),
        edition_flow_id: String(r.edition_flow_id),
        slot_name: String(r.slot_name ?? "default"),
        last_refreshed_at: r.last_refreshed_at ?? null,
      })
    }
    if (rows.length < POOL_READ_PAGE) break
  }
  return out
}

async function runBackgroundWork(startedAtIso: string, started: number, cursor: string | null) {
  try {
    const atlas = defaultAtlasDeps()
    const { offset, reset: cursorReset } = parseOffsetCursor(cursor)
    const page = await searchDistributionsPage(ATLAS_PRODUCT, offset, PAGE_LIMIT, atlas)

    if (!page.ok) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `atlas: ${page.error}`,
        extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas", atlas_requests: page.requests, offset, cursor_reset: cursorReset },
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
          source: "atlas", atlas_requests: page.requests, offset, total_count: page.totalCount, cursor_reset: cursorReset,
        },
        cursorBefore: cursor, cursorAfter: endCursor,
      })
      return
    }

    // === Phase 0: the stored pool of each distribution (Atlas has none for laliga) ===
    const nodes: DistNode[] = []
    const noPoolSource: string[] = []
    let oldestPoolConfirmedAt: string | null = null
    for (const d of page.dists) {
      const pool = await readStoredPool(d.id)
      if (pool.length === 0) { noPoolSource.push(d.id); continue }
      for (const r of pool) {
        if (r.last_refreshed_at && (oldestPoolConfirmedAt == null || r.last_refreshed_at < oldestPoolConfirmedAt)) {
          oldestPoolConfirmedAt = r.last_refreshed_at
        }
      }
      nodes.push({ ...d, pool })
    }

    // === Phase 1: bulk edition + FMV lookups ===
    const allExternalIds = new Set<string>()
    for (const n of nodes) for (const r of n.pool) allExternalIds.add(r.edition_flow_id)

    const editionByExternalId = new Map<string, { id: string; tier: string | null; circ: number | null }>()
    const externalIdList = Array.from(allExternalIds)
    for (let i = 0; i < externalIdList.length; i += EXTERNAL_ID_CHUNK) {
      const chunk = externalIdList.slice(i, i + EXTERNAL_ID_CHUNK)
      const { data: rows, error } = await supabase
        .from("editions")
        .select("id, external_id, tier, circulation_count")
        .eq("collection_id", GOLAZOS_COLLECTION_ID)
        .in("external_id", chunk)
      if (error) throw new Error(`editions chunk: ${error.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (rows ?? []) as any[]) {
        editionByExternalId.set(String(r.external_id), { id: r.id, tier: r.tier, circ: r.circulation_count })
      }
    }

    const editionUuids = Array.from(editionByExternalId.values()).map(v => v.id)
    const fmvByEditionId = new Map<string, number>()
    // 2026-09-22 (v3): CHUNKED — PostgREST clamps every RPC result to max-rows =
    // 1000, and the AllDay twin of this call silently returned exactly 1,000 of
    // 1,488 rows. Golazos peaks near 320 today; the chunk keeps it correct at any size.
    for (let i = 0; i < editionUuids.length; i += FMV_ID_CHUNK) {
      const { data: fmvRows, error: fmvErr } = await supabase.rpc("get_fmv_for_editions", {
        p_collection_id: GOLAZOS_COLLECTION_ID,
        p_edition_ids: editionUuids.slice(i, i + FMV_ID_CHUNK),
      })
      if (fmvErr) throw new Error(`get_fmv_for_editions: ${fmvErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (fmvRows ?? []) as any[]) {
        if (r.fmv_usd != null) fmvByEditionId.set(String(r.edition_id), Number(r.fmv_usd))
      }
    }

    // === Phase 2: re-weight each stored pool by current circulation ===
    const counters = {
      nodes_processed: 0, nodes_no_editions: 0, nodes_no_fmv_coverage: 0,
      pool_rows_written: 0, pool_write_errors: 0, ev_rows_written: 0, single_edition_packs: 0,
      rpc_not_ok: 0, rpc_errors: 0, weighted_count: 0,
      nodes_no_pool_source: noPoolSource.length, nodes_price_or_slots_unknown: 0, nodes_supply_unknown: 0,
      pool_rows_edition_missing: 0, malformed_distributions: page.malformed,
    }
    const poolRowsByDist: Record<string, Array<Record<string, unknown>>> = {}
    const distMeta: Record<string, { node: DistNode; editionsWithFmv: number; editionCount: number }> = {}

    for (const node of nodes) {
      counters.nodes_processed++
      const pooledEditions: Array<{ row: StoredPoolRow; fmv: number | null; circ: number | null }> = []
      for (const row of node.pool) {
        const ed = editionByExternalId.get(row.edition_flow_id)
        // A stored row whose edition no longer resolves keeps its stored weight (this
        // lane does not prune); it is counted so the gap is visible.
        if (!ed) { counters.pool_rows_edition_missing++; continue }
        pooledEditions.push({ row, fmv: fmvByEditionId.get(ed.id) ?? null, circ: ed.circ })
      }

      const editionCount = pooledEditions.length
      const editionsWithFmv = pooledEditions.filter(p => p.fmv != null).length
      if (editionCount === 0) { counters.nodes_no_editions++; continue }
      if (editionsWithFmv === 0) { counters.nodes_no_fmv_coverage++; continue }
      if (editionCount === 1) counters.single_edition_packs++

      const distId = node.id
      distMeta[distId] = { node, editionsWithFmv, editionCount }

      // supplyWeightPool (../_shared) is the pinned, unit-tested copy of this math.
      // Only the WEIGHT columns are sent: last_refreshed_at (membership last read)
      // and pool_source are left as Studio last wrote them.
      const weights = supplyWeightPool(pooledEditions.map(p => p.circ))
      poolRowsByDist[distId] = pooledEditions.map((p, i) => ({
        collection_id: GOLAZOS_COLLECTION_ID,
        dist_id: distId,
        edition_id: p.row.edition_id,
        edition_flow_id: p.row.edition_flow_id,
        slot_name: p.row.slot_name,
        drop_weight: weights[i],
        orig_drop_weight: weights[i],
      }))
    }

    // === Phase 3: rewrite the weights of each stored pool (no add, no prune) ===
    // R123: every write error is counted and fails the run at the terminal row; a
    // distribution whose weights did not land gets no EV row from a stale pool.
    const poolWriteErrors: string[] = []
    for (const [distId, rows] of Object.entries(poolRowsByDist)) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const { error: ie } = await supabase.from("pack_drop_pool")
          .upsert(chunk, { onConflict: "collection_id,dist_id,edition_id,slot_name" })
        if (ie) { poolWriteErrors.push(`pool weight upsert ${distId}: ${ie.message}`); delete distMeta[distId]; break }
        counters.pool_rows_written += chunk.length
      }
    }
    counters.pool_write_errors = poolWriteErrors.length

    // === Phase 4: compute supply-weighted EV per distribution via RPC ===
    const evRows: Array<Record<string, unknown>> = []
    for (const [distId, meta] of Object.entries(distMeta)) {
      const { node } = meta
      // Atlas omits a field it does not know. An unknown price or slot count is
      // not $0 / 1 slot — the EV row would be a fabrication, so it is skipped.
      if (node.price == null || node.numberOfPackSlots == null) { counters.nodes_price_or_slots_unknown++; continue }
      const slots = Math.max(1, node.numberOfPackSlots)
      const packPrice = node.price

      const { data: rpcResult, error: rpcErr } = await supabase.rpc("compute_pack_ev_per_edition_weighted", {
        p_collection_id: GOLAZOS_COLLECTION_ID,
        p_dist_id: distId,
        p_pack_price: packPrice,
        p_slots: slots,
      })

      if (rpcErr) {
        counters.rpc_errors++
        console.log(`[compute-golazos-pack-ev] rpc err dist=${distId}: ${rpcErr.message}`)
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
        collection_id: GOLAZOS_COLLECTION_ID,
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
          startedAt: startedAtIso, rowsFound: page.rawCount, rowsWritten: 0, rowsSkipped: page.rawCount,
          ok: false, error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas", atlas_requests: page.requests },
          cursorBefore: cursor, cursorAfter: endCursor,
        })
        return
      }
    }

    const errors: string[] = []
    if (poolWriteErrors.length) errors.push(`${poolWriteErrors.length} pool write error(s): ${poolWriteErrors.slice(0, 2).join(" | ")}`)
    if (page.malformed) errors.push(`${page.malformed} Atlas distribution row(s) without uuid/id`)
    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: page.rawCount,
      rowsWritten: counters.ev_rows_written,
      rowsSkipped: counters.nodes_no_editions + counters.nodes_no_fmv_coverage + counters.rpc_not_ok + counters.rpc_errors +
        counters.nodes_no_pool_source + counters.nodes_price_or_slots_unknown,
      ok: errors.length === 0,
      error: errors.length ? errors.join(" ; ").slice(0, 500) : null,
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
        // Membership is NOT from this run: it is the pool Studio last confirmed.
        pool_membership_source: "stored_studio_pool",
        pool_membership_oldest_confirmed_at: oldestPoolConfirmedAt,
        no_pool_source_sample: noPoolSource.slice(0, 10),
        atlas_requests: page.requests,
        offset,
        total_count: page.totalCount,
        cursor_reset: cursorReset,
      },
      cursorBefore: cursor, cursorAfter: endCursor,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-golazos-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas" },
      cursorBefore: cursor,
    })
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    const gate = await checkCronGate(req, supabase, "compute-golazos-pack-ev")
    if (gate === "unavailable") return cronGateResponse(gate)!
    if (gate !== "ok") return new Response("Unauthorized", { status: 401 })
  }

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
