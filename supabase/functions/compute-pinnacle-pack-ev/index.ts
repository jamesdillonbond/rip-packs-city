// compute-pinnacle-pack-ev v2 — supply-weighted (total_minted) per-render EV.
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
// pack_listing_id, snapshotted_at DESC). The studio GQL caps pages at ~40, so
// the ~140 Pinnacle dists are walked via cursor WITHIN one invocation (~4
// pages) — each run is a full refresh, not a partial page.
//
// Revert: delete this function + its cron; DELETE FROM pack_ev_history and
// pack_distributions WHERE collection_id = the Pinnacle uuid.

import { createClient } from "@supabase/supabase-js"
import { computeDepletionPct, weightedMeanEv } from "../_shared/pack-ev-supply-weighted.ts"

// Gated by ?key=GATE (matches the ingest/backfill pg_cron convention);
// deployed with verify_jwt=false. A Bearer INGEST_SECRET_TOKEN header is also
// accepted for manual/authenticated triggering.
// ⚠ This block used to argue that GATE was "a low-risk cron identifier, not a
// high-value secret, so keeping it in source keeps INGEST_SECRET_TOKEN out of
// cron.job". The second half is a real requirement; the first half was wrong.
// The gate is the SOLE auth on a service-role writer, and this repo is public —
// so it was a world-readable key to a prod write path. Reading it from an edge
// secret keeps INGEST_SECRET_TOKEN out of cron.job AND keeps the gate out of git.
// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set PINNACLE_PACK_EV_GATE_KEY=<new-random>
const GATE = Deno.env.get("PINNACLE_PACK_EV_GATE_KEY") ?? ""
const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN") ?? ""

const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const GQL_ENDPOINT = "https://api.production.studio-platform.dapperlabs.com/graphql"
const EDITION_ID_CHUNK = 500

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const H = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://disneypinnacle.com",
  "Referer": "https://disneypinnacle.com/",
}

const SEARCH_QUERY = `
  query FetchPinnacleDistributions($input: SearchDistributionsInput!) {
    searchDistributions(input: $input) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges {
        node {
          uuid id title
          numberOfPackSlots
          totalSupply availableSupply
          price { value }
          editionIds
          packOdds { tier value displayValue }
        }
      }
    }
  }
`

interface DistNode {
  uuid: string; id: number; title: string | null
  numberOfPackSlots: number | null
  availableSupply: number | null; totalSupply: number | null
  price: { value: string } | null
  editionIds: number[] | null
  packOdds: Array<{ tier: string; value: number; displayValue: string | null }> | null
}

async function gqlCall(query: string, variables: Record<string, unknown>) {
  const res = await fetch(GQL_ENDPOINT, {
    method: "POST", headers: H,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(25000),
  })
  if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
  const json = await res.json().catch(() => null) as
    | { data?: unknown; errors?: Array<{ message: string }> } | null
  if (!json) return { ok: false as const, error: "not-json" }
  if (json.errors?.length) return { ok: false as const, error: json.errors[0].message }
  return { ok: true as const, data: json.data }
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

async function runBackgroundWork(startedAtIso: string, started: number) {
  try {
    // The studio GQL caps each page at ~40 nodes regardless of `first`, so walk
    // the cursor within this single invocation until drained (≈140 dists / ~4
    // pages) — each run is thus a full refresh, not a partial page.
    const nodes: DistNode[] = []
    let totalCount: number | null = null
    let cursor: string | null = null
    let pages = 0
    while (pages < 12) {
      const gqlRes = await gqlCall(SEARCH_QUERY, {
        input: { first: 100, after: cursor, filters: { byProductID: "Pinnacle" } },
      })
      if (!gqlRes.ok) {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: nodes.length, rowsWritten: 0, rowsSkipped: 0,
          ok: false, error: `gql page ${pages}: ${gqlRes.error}`,
          extra: { elapsed_ms: Date.now() - started, function_version: 2, pages_fetched: pages },
        })
        return
      }
      // deno-lint-ignore no-explicit-any
      const data = gqlRes.data as any
      const sd = data?.searchDistributions
      totalCount = sd?.totalCount ?? totalCount
      for (const e of (sd?.edges ?? [])) {
        const n = e?.node
        if (n != null) nodes.push(n)
      }
      pages++
      if (sd?.pageInfo?.hasNextPage !== true) break
      cursor = sd?.pageInfo?.endCursor ?? null
      if (!cursor) break
    }

    if (nodes.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { message: "empty", elapsed_ms: Date.now() - started, function_version: 2, total_count: totalCount, pages_fetched: pages },
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
    }
    const evRows: Array<Record<string, unknown>> = []
    const distRows: Array<Record<string, unknown>> = []

    for (const node of nodes) {
      counters.nodes_processed++
      const distId = String(node.id)
      const total = node.totalSupply ?? 0
      const available = node.availableSupply ?? 0
      const slots = Math.max(1, node.numberOfPackSlots ?? 1)
      const packPrice = node.price?.value != null ? Number(node.price.value) : 0
      const depletionPct = computeDepletionPct(total, available)

      // pack_distributions row (drives pack_table_rows / the packs page).
      // total_sealed + depletion_pct are GENERATED from total_opened, so we can't
      // write them. We have no Pinnacle pack-open ingest, so approximate
      // total_opened with packs-consumed = totalSupply - availableSupply (packs
      // no longer on primary sale). That makes the generated total_sealed resolve
      // to availableSupply and depletion_pct to the sold fraction — the metric the
      // UI wants — instead of a false 0% for sold-out packs.
      const consumed = Math.max(total - available, 0)
      distRows.push({
        collection_id: PINNACLE_COLLECTION_ID,
        dist_id: distId,
        title: node.title,
        nft_type: "Pinnacle",
        total_minted: total,
        total_opened: consumed,
        metadata: {
          retail_price_usd: packPrice,
          number_of_pack_slots: slots,
          source: "studio_platform_gql",
          // Persist the render pool so v_pinnacle_pack_ev_corrected can recompute
          // a median-robust EV (unnest edition_ids → pinnacle_catalog).
          edition_ids: node.editionIds ?? [],
        },
        updated_at: new Date().toISOString(),
      })
      counters.dist_rows_built++

      const editionIds = (node.editionIds ?? []).map(String)
      if (editionIds.length === 0) { counters.nodes_no_editions++; continue }

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
    let distWritten = 0
    for (let i = 0; i < distRows.length; i += 500) {
      const chunk = distRows.slice(i, i + 500)
      const { error: de } = await supabase
        .from("pack_distributions")
        .upsert(chunk, { onConflict: "dist_id,collection_id" })
      if (de) throw new Error(`upsert pack_distributions: ${de.message}`)
      distWritten += chunk.length
    }

    // === Phase 3b: bulk insert pack_ev_history ===
    let evWritten = 0
    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (evErr) {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: nodes.length, rowsWritten: distWritten, rowsSkipped: nodes.length,
          ok: false, error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, dist_written: distWritten, elapsed_ms: Date.now() - started, function_version: 2 },
        })
        return
      }
      evWritten = evRows.length
    }

    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: nodes.length,
      rowsWritten: evWritten,
      rowsSkipped: counters.nodes_no_editions + counters.nodes_no_fmv_coverage,
      ok: true,
      extra: {
        ...counters,
        dist_written: distWritten,
        editions_resolved: renderByEditionId.size,
        editions_requested: allEditionIds.size,
        elapsed_ms: Date.now() - started,
        function_version: 2,
        ev_method: "supply_weighted_inline",
        total_count: totalCount,
        pages_fetched: pages,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-pinnacle-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: 2 },
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  const url = new URL(req.url)
  const keyParam = url.searchParams.get("key")
  const authed = (!!GATE && keyParam === GATE) ||
    (INGEST_SECRET_TOKEN !== "" && auth === `Bearer ${INGEST_SECRET_TOKEN}`)
  if (!authed) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403, headers: { "content-type": "application/json" },
    })
  }

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
