// compute-pinnacle-pack-ev v3 — supply-weighted (total_minted) per-render EV, read from Dapper Atlas.
//
// v3 (2026-11-18 PT) — STUDIO → ATLAS. The Studio Platform GraphQL this read
// (searchDistributions, byProductID "Pinnacle") has answered HTTP 530 since 11-17
// 4:23 PM PT. Every field it consumed is now read from Dapper Atlas
// (../_shared/atlas-distributions.ts, field map in its header):
//   uuid/id/title/numberOfPackSlots/totalSupply/availableSupply/price
//       ← DistributionService/SearchDistributions {product:"disney"} (all pages)
//   editionIds (the render pool)
//       ← DistributionService/GetDistributionEditions {product:"disney", distributionId}
//         (disney 8542 → 53 editionIds = the 53 Studio wrote into
//         pack_distributions.metadata.edition_ids; ids join pinnacle_catalog.edition_id)
// Same tables, same columns. Differences, all honesty:
//   · a distribution whose pool read fails is skipped (no pack_distributions row,
//     no EV row) and fails the run with the HTTP status in the error.
//   · Atlas OMITS totalSupply/availableSupply on some live draws (8923, 11-18):
//     those rows upsert WITHOUT total_minted/total_opened, so the last known counts
//     stand and metadata carries no supply_as_of (the depletion figure has no age).
//     The old `total = totalSupply ?? 0` would have zeroed a known supply.
//   · an unknown price or slot count skips the EV row (counted) instead of pricing
//     the pack at $0 / 1 slot; metadata.retail_price_usd is null, not 0.
//   · metadata.source is "atlas_distribution_service" (was "studio_platform_gql").
//
// v2 (2026-07-18, reconciled into the repo 2026-07-25): also persist typical_ev
// (the supply-weighted-MEDIAN "Typical Pull EV"), bringing Pinnacle to parity
// with the TopShot/AllDay/Golazos writers. Pinnacle computes EV without the
// shared RPC, so the median is computed alongside the weighted mean in
// ../_shared/pack-ev-supply-weighted.ts (weightedMedianFmv), matching
// compute_pack_ev_per_edition_weighted EXACTLY: over renders WITH fmv, sorted by
// fmv ascending, typical_per_slot = min(fmv) where cumulative total_minted >=
// 0.5 * total weight, then typical_ev = round2(typical_per_slot * slots) clamped
// [0, 1e6]. Null-guarded; pack_ev_history.typical_ev + the read stack
// (mv_pack_ev_latest / pack_table_rows) already carry the column.
//
// NOTE (repo↔prod): v2 was deployed via the Supabase MCP on 2026-07-18 but the
// repo copy stayed at v1, and the 2026-07-20 _shared rewire (fb7eb0f2) refactored
// that v1 body — so the repo was simultaneously ahead (shared module) and behind
// (no typical_ev) production. Reconciled 2026-07-25 so a deploy of this file can
// no longer silently drop the typical_ev write. Revert: remove the typical_ev
// field from the evRows push.
//
// Pinnacle mirrors the AllDay pack-EV model (compute-allday-pack-ev v8) but with
// two structural differences:
//   1. Pinnacle is render-keyed: pack editionIds join pinnacle_catalog.edition_id
//      (text, 1:1 with render_id) which carries total_minted (supply) + fmv_usd
//      directly — there is NO editions/get_fmv_for_editions path and NO
//      pack_drop_pool path (pack_drop_pool.edition_id FKs editions.id, so
//      render-keyed rows can't be inserted there).
//   2. EV is computed INLINE, replicating compute_pack_ev_per_edition_weighted
//      exactly: per_slot_ev = Σ(wᵢ·fmvᵢ) / Σwᵢ over renders WITH fmv only
//      (wᵢ = total_minted; NULL-fmv renders excluded from both num and denom),
//      gross_ev = round(per_slot_ev · max(slots,1), 2), pack_ev clamped
//      [-10000, 1000000]. Dapper populates NO packOdds for Pinnacle (empty every
//      probe), so supply share is the authoritative pull-probability signal.
//
// This fn owns the whole Pinnacle pack surface: it upserts pack_distributions
// (so pack_table_rows / the /disney-pinnacle/packs page has rows) AND writes
// pack_ev_history (deduped downstream by mv_pack_ev_latest via DISTINCT ON
// pack_listing_id, snapshotted_at DESC). The ~160 Pinnacle dists are walked
// (Atlas, 100 a page) WITHIN one invocation — each run is a full refresh, not a
// partial page.
//
// Revert: delete this function + its cron; DELETE FROM pack_ev_history and
// pack_distributions WHERE collection_id = the Pinnacle uuid.

import { createClient } from "@supabase/supabase-js"
import { checkCronGate, cronGateResponse } from "../_shared/cron-gate.ts"
import { computeDepletionPct, weightedMeanEv } from "../_shared/pack-ev-supply-weighted.ts"
import { dedupeByConflictKey } from "../_shared/upsert-dedupe.ts"
import {
  type AtlasDist,
  defaultAtlasDeps,
  fetchDistributionEditionIds,
  searchAllDistributions,
  supplyOf,
} from "../_shared/atlas-distributions.ts"

// Gated by ?key=GATE (matches the ingest/backfill pg_cron convention);
// deployed with verify_jwt=false. A Bearer INGEST_SECRET_TOKEN header is also
// accepted for manual/authenticated triggering.
// ⚠ This block used to argue that GATE was "a low-risk cron identifier, not a
// high-value secret, so keeping it in source keeps INGEST_SECRET_TOKEN out of
// cron.job". The second half is a real requirement; the first half was wrong.
// The gate is the SOLE auth on a service-role writer, and this repo is public —
// so it was a world-readable key to a prod write path. Reading it from an edge
// secret keeps INGEST_SECRET_TOKEN out of cron.job AND keeps the gate out of git.
// Gate (2026-10-13): ../_shared/cron-gate.ts — the key (x-rpc-gate-key header or ?key=) is
// checked against the SAME Vault secret pg_cron sends, cron_gate_key('compute-pinnacle-pack-ev'). No env
// secret is read; a rotation is one vault.update_secret (rpc-edge-fn-deploy §0).
const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN") ?? ""

const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const ATLAS_PRODUCT = "disney" as const
const FUNCTION_VERSION = 3
const EDITION_ID_CHUNK = 500

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

/** A distribution plus the render pool Atlas returned for it — the Studio node's shape, re-sourced. */
interface DistNode extends AtlasDist {
  editionIds: string[]
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "compute-pinnacle-pack-ev",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "disney-pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

// The weighted-mean EV, the weighted-median Typical Pull EV, and the clamp/round
// math all live in ../_shared (weightedMeanEv → { grossEv, packEv, typicalEv, … }
// and weightedMedianFmv), the pinned + unit-tested copies. Both the clamp and the
// median semantics are identical to compute_pack_ev_per_edition_weighted.

/** The terminal row's error: each failure class, counted, with the first messages (they carry "HTTP <status>"). */
function runErrorText(poolReadErrors: string[], malformed: number): string | null {
  const parts: string[] = []
  if (poolReadErrors.length) parts.push(`${poolReadErrors.length} pool read error(s): ${poolReadErrors.slice(0, 2).join(" | ")}`)
  if (malformed) parts.push(`${malformed} Atlas distribution row(s) without uuid/id`)
  return parts.length ? parts.join(" ; ").slice(0, 500) : null
}

async function runBackgroundWork(startedAtIso: string, started: number) {
  try {
    // Every Pinnacle distribution (~160), all pages, all or nothing — then each
    // one's render pool, one request at a time (Atlas's Cloudflare is burst-
    // sensitive). Each run is a full refresh, as it was on Studio.
    const atlas = defaultAtlasDeps()
    const walk = await searchAllDistributions(ATLAS_PRODUCT, atlas)
    let atlasRequests = walk.requests
    if (!walk.ok) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `atlas: ${walk.error}`,
        extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas", atlas_requests: atlasRequests },
      })
      return
    }
    const totalCount = walk.totalCount
    const pages = walk.pages

    const nodes: DistNode[] = []
    const poolReadErrors: string[] = []
    for (const d of walk.dists) {
      await atlas.sleep(atlas.gapMs)
      const pool = await fetchDistributionEditionIds(ATLAS_PRODUCT, d.id, atlas)
      atlasRequests += pool.requests
      if (!pool.ok) { poolReadErrors.push(pool.error); continue }
      nodes.push({ ...d, editionIds: pool.editionIds })
    }

    // When availableSupply was read. pack_table_rows dates Pinnacle's depletion % from
    // metadata.supply_as_of; pd.updated_at is not that age (pack_distributions has a
    // second Pinnacle writer).
    const supplyReadAt = new Date().toISOString()

    // "Empty" only when Atlas itself listed nothing. Distributions whose pools all
    // failed to read are NOT an empty catalog: they fall through to the terminal
    // row, which fails the run.
    if (walk.dists.length === 0 && walk.malformed === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: {
          message: "empty", elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION,
          total_count: totalCount, pages_fetched: pages, source: "atlas", atlas_requests: atlasRequests,
        },
      })
      return
    }

    // === Phase 1: bulk pinnacle_catalog lookup (render supply + fmv) ===
    const allEditionIds = new Set<string>()
    for (const n of nodes) for (const eid of n.editionIds ?? []) allEditionIds.add(String(eid))

    const renderByEditionId = new Map<string, { total_minted: number | null; fmv_usd: number | null }>()
    const editionIdList = Array.from(allEditionIds)
    for (let i = 0; i < editionIdList.length; i += EDITION_ID_CHUNK) {
      const chunk = editionIdList.slice(i, i + EDITION_ID_CHUNK)
      const { data: rows, error } = await supabase
        .from("pinnacle_catalog")
        .select("edition_id, total_minted, fmv_usd")
        .in("edition_id", chunk)
      if (error) throw new Error(`pinnacle_catalog chunk: ${error.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (rows ?? []) as any[]) {
        renderByEditionId.set(String(r.edition_id), {
          total_minted: r.total_minted == null ? null : Number(r.total_minted),
          fmv_usd: r.fmv_usd == null ? null : Number(r.fmv_usd),
        })
      }
    }

    // === Phase 2: per-dist inline weighted EV + pack_distributions upsert ===
    const counters = {
      nodes_processed: 0, nodes_no_editions: 0, nodes_no_fmv_coverage: 0,
      ev_rows_built: 0, dist_rows_built: 0, single_edition_packs: 0,
      nodes_pool_read_failed: poolReadErrors.length, nodes_price_or_slots_unknown: 0, nodes_supply_unknown: 0,
      malformed_distributions: walk.malformed,
    }
    const evRows: Array<Record<string, unknown>> = []
    // Two batches, because a PostgREST bulk upsert sends the UNION of the rows' keys
    // and NULLs the ones a row lacks: total_minted/total_opened are NOT NULL, and a
    // row whose supply Atlas did not report must leave the stored counts alone.
    const distRows: Array<Record<string, unknown>> = []
    const distRowsNoSupply: Array<Record<string, unknown>> = []

    for (const node of nodes) {
      counters.nodes_processed++
      const distId = String(node.id)
      // A missing count is unknown, not 0: `?? 0` made a dist read as 100 % sold.
      const supply = supplyOf(node)
      const supplyRead = supply.read
      if (!supplyRead) counters.nodes_supply_unknown++
      const available = supply.read ? supply.available : null
      // Unknown price / slot count: no EV row (below). Not $0 / 1 slot.
      const slots = node.numberOfPackSlots != null ? Math.max(1, node.numberOfPackSlots) : null
      const packPrice = node.price
      const depletionPct = supply.read ? computeDepletionPct(supply.total, supply.available) : null

      // pack_distributions row (drives pack_table_rows / the packs page).
      // total_sealed + depletion_pct are GENERATED from total_opened, so we can't
      // write them. We have no Pinnacle pack-open ingest, so approximate
      // total_opened with packs-consumed = totalSupply - availableSupply (packs
      // no longer on primary sale). That makes the generated total_sealed resolve
      // to availableSupply and depletion_pct to the sold fraction — the metric the
      // UI wants — instead of a false 0% for sold-out packs.
      // Unknown supply: the row carries NO total_minted/total_opened (a new row gets
      // the column defaults, 0/0 — a generated 0 % that pack_table_rows reads as
      // absent; an existing row keeps its last read counts, now ageless).
      const distRow: Record<string, unknown> = {
        collection_id: PINNACLE_COLLECTION_ID,
        dist_id: distId,
        title: node.title,
        nft_type: "Pinnacle",
        ...(supply.read
          ? { total_minted: supply.total, total_opened: Math.max(supply.total - supply.available, 0) }
          : {}),
        metadata: {
          retail_price_usd: packPrice,
          number_of_pack_slots: slots,
          source: "atlas_distribution_service",
          // Persist the render pool so v_pinnacle_pack_ev_corrected can recompute
          // a median-robust EV (unnest edition_ids → pinnacle_catalog). Numbers, as
          // Studio wrote them (Atlas sends the ids as strings).
          edition_ids: node.editionIds.map(Number),
          // Stamped only when Atlas returned both counts. Without them the
          // depletion figure is not a read, so it gets no age.
          ...(supplyRead
            ? { supply_as_of: supplyReadAt }
            : {}),
        },
        updated_at: new Date().toISOString(),
      }
      if (supply.read) distRows.push(distRow)
      else distRowsNoSupply.push(distRow)
      counters.dist_rows_built++

      const editionIds = node.editionIds
      if (editionIds.length === 0) { counters.nodes_no_editions++; continue }
      if (packPrice == null || slots == null) { counters.nodes_price_or_slots_unknown++; continue }

      // Weighted mean over renders WITH fmv only (matches the canonical RPC).
      // weightedMeanEv (../_shared) is the pinned, unit-tested copy of this math.
      // Pass only the renders that RESOLVED to a catalog row — missing renders are
      // skipped before the coverage count, exactly as the inline loop did (the
      // `if (!r) continue` before editionCount++).
      const foundRenders = editionIds
        .map((ext) => renderByEditionId.get(ext))
        .filter((r): r is NonNullable<typeof r> => r != null)
      const ev = weightedMeanEv(
        foundRenders.map((r) => ({ circ: r.total_minted, fmv: r.fmv_usd })),
        slots,
        packPrice,
      )

      if (ev.editionCount === 0) { counters.nodes_no_editions++; continue }
      if (!ev.ok) { counters.nodes_no_fmv_coverage++; continue }
      if (ev.editionCount === 1) counters.single_edition_packs++

      evRows.push({
        pack_listing_id: node.uuid,
        collection_id: PINNACLE_COLLECTION_ID,
        dist_id: distId,
        pack_name: node.title,
        pack_price: packPrice,
        gross_ev: ev.grossEv,
        pack_ev: ev.packEv,
        typical_ev: ev.typicalEv,
        is_positive_ev: ev.isPositiveEv,
        value_ratio: ev.valueRatio,
        fmv_coverage_pct: Math.min(ev.fmvCoveragePct, 32767),
        edition_count: Math.min(ev.editionCount, 32767),
        total_unopened: available,
        depletion_pct: depletionPct,
      })
      counters.ev_rows_built++
    }

    // === Phase 3a: upsert pack_distributions (dist_id, collection_id) ===
    //
    // ⚠ Dedupe on the conflict key FIRST. `ON CONFLICT DO UPDATE` cannot touch
    // the same target row twice, so two upstream nodes sharing a dist_id abort
    // the whole statement with 21000 and discard every other row in the chunk.
    // That is what pinned this function at 100% failure from 2026-08-11 06:17Z
    // — 4 identical `cannot affect row a second time` ticks a day, Pinnacle
    // pack EV frozen, because the throw here also skips Phase 3b.
    //
    // collection_id is constant for this function, so dist_id alone is the key.
    // The collision count is REPORTED, never swallowed: a quiet dedupe would
    // trade a loud deterministic failure for an invisible one, and two nodes
    // under one dist_id is a genuine upstream anomaly worth seeing. If
    // dist_dupe_count stays non-zero, investigate the studio-platform walk
    // rather than treating this as the fix.
    const dedupedDists = dedupeByConflictKey(
      [...distRows, ...distRowsNoSupply],
      (r) => String((r as { dist_id: unknown }).dist_id),
    )
    const keptWithSupply = dedupedDists.rows.filter((r) => "total_minted" in r)
    const keptNoSupply = dedupedDists.rows.filter((r) => !("total_minted" in r))
    let distWritten = 0
    for (const batch of [keptWithSupply, keptNoSupply]) {
      for (let i = 0; i < batch.length; i += 500) {
        const chunk = batch.slice(i, i + 500)
        const { error: de } = await supabase
          .from("pack_distributions")
          .upsert(chunk, { onConflict: "dist_id,collection_id" })
        if (de) throw new Error(`upsert pack_distributions: ${de.message}`)
        distWritten += chunk.length
      }
    }

    // === Phase 3b: bulk insert pack_ev_history ===
    let evWritten = 0
    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (evErr) {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: walk.dists.length, rowsWritten: distWritten, rowsSkipped: walk.dists.length,
          ok: false, error: `insert pack_ev_history: ${evErr.message}`,
          extra: {
            counters, dist_written: distWritten,
            dist_dupe_count: dedupedDists.duplicates,
            dist_dupe_sample: dedupedDists.duplicateKeys,
            elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION,
            source: "atlas", atlas_requests: atlasRequests,
          },
        })
        return
      }
      evWritten = evRows.length
    }

    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: walk.dists.length,
      rowsWritten: evWritten,
      rowsSkipped: counters.nodes_no_editions + counters.nodes_no_fmv_coverage +
        counters.nodes_pool_read_failed + counters.nodes_price_or_slots_unknown,
      // ok = every listed distribution was read and written. A pool that could not
      // be read (its HTTP status is in the error) or a malformed Atlas row fails it.
      ok: poolReadErrors.length === 0 && walk.malformed === 0,
      error: runErrorText(poolReadErrors, walk.malformed),
      extra: {
        ...counters,
        dist_written: distWritten,
        dist_dupe_count: dedupedDists.duplicates,
        dist_dupe_sample: dedupedDists.duplicateKeys,
        editions_resolved: renderByEditionId.size,
        editions_requested: allEditionIds.size,
        elapsed_ms: Date.now() - started,
        function_version: FUNCTION_VERSION,
        ev_method: "supply_weighted_inline",
        total_count: totalCount,
        pages_fetched: pages,
        source: "atlas",
        atlas_requests: atlasRequests,
        pool_read_errors_sample: poolReadErrors.slice(0, 3),
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-pinnacle-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: FUNCTION_VERSION, source: "atlas" },
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  const bearerOk = INGEST_SECRET_TOKEN !== "" && auth === `Bearer ${INGEST_SECRET_TOKEN}`
  const gate = bearerOk ? "ok" : await checkCronGate(req, supabase, "compute-pinnacle-pack-ev")
  if (gate !== "ok") return cronGateResponse(gate)!

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runBackgroundWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch((e) => console.log(`waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      note: "Real results will appear in pipeline_runs within ~40s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
