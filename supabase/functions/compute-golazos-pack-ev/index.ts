// compute-golazos-pack-ev v2 — supply-weighted (circulation) per-edition EV.
//
// v2 (2026-07-18, reconciled into the repo 2026-07-25): also persist typical_ev
// (the weighted-MEDIAN "Typical Pull EV" returned by
// compute_pack_ev_per_edition_weighted as typical_pull_ev) alongside gross_ev —
// parity with the TopShot/AllDay writers. Null-guarded; the column is already in
// pack_ev_history and the read stack (mv_pack_ev_latest / pack_table_rows).
//
// NOTE (repo↔prod): v2 was deployed via the Supabase MCP on 2026-07-18 but the
// repo copy stayed at v1, and the 2026-07-20 _shared rewire (fb7eb0f2) refactored
// that v1 body — so the repo was simultaneously ahead (shared module) and behind
// (no typical_ev) production. Reconciled 2026-07-25 so a deploy of this file can
// no longer silently drop the typical_ev write. Revert: remove the typical_ev
// field from the evRows push.
//
// Cloned from compute-allday-pack-ev v8. LaLiga Golazos is editions-keyed like
// AllDay (editions.external_id = the studio edition id as an integer string), and
// uses the SAME Studio Platform searchDistributions API (byProductID: "Golazos").
// Dapper does not publish per-tier packOdds for Golazos, so EV is supply-weighted:
// an edition's pull probability ~ its share of minted circulation.
// Auth: accepts EITHER Bearer INGEST_SECRET_TOKEN (manual/CC) OR ?key=<CRON_KEY>
// (pg_cron net.http_get, mirroring compute-pinnacle-pack-ev).
// Revert: DROP the compute-golazos-pack-ev function + its cron job.

import { createClient } from "@supabase/supabase-js"
import { supplyWeightPool, computeDepletionPct } from "../_shared/pack-ev-supply-weighted.ts"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")
// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set GOLAZOS_PACK_EV_GATE_KEY=<new-random>
const GOLAZOS_CRON_KEY = Deno.env.get("GOLAZOS_PACK_EV_GATE_KEY") ?? ""
// Transitional SECOND key, read from its own secret — never a literal (this repo is PUBLIC).
// During a key rotation, set GOLAZOS_PACK_EV_GATE_KEY_OLD to the OUTGOING key: both are then accepted, so the
// pg_cron ?key= values can be repointed one job at a time instead of atomically. Finish the
// rotation by DELETING the _OLD secret — no redeploy needed. Both unset ⇒ still fails CLOSED.
const GOLAZOS_CRON_KEY_OLD = Deno.env.get("GOLAZOS_PACK_EV_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GOLAZOS_CRON_KEY !== "" && k === GOLAZOS_CRON_KEY) || (GOLAZOS_CRON_KEY_OLD !== "" && k === GOLAZOS_CRON_KEY_OLD))
}

const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const GQL_ENDPOINT = "https://api.production.studio-platform.dapperlabs.com/graphql"
const EXTERNAL_ID_CHUNK = 500

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const H = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://laligagolazos.com",
  "Referer": "https://laligagolazos.com/",
}

const SEARCH_QUERY = `
  query FetchGolazosDistributions($input: SearchDistributionsInput!) {
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

async function runBackgroundWork(startedAtIso: string, started: number, cursor: string | null) {
  try {
    const gqlRes = await gqlCall(SEARCH_QUERY, {
      input: {
        first: 100,
        after: cursor ?? null,
        filters: { byProductID: "Golazos" },
      },
    })

    if (!gqlRes.ok) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `gql: ${gqlRes.error}`,
        extra: { elapsed_ms: Date.now() - started, function_version: 2 },
        cursorBefore: cursor,
      })
      return
    }

    // deno-lint-ignore no-explicit-any
    const data = gqlRes.data as any
    const nodes: DistNode[] = (data?.searchDistributions?.edges ?? [])
      // deno-lint-ignore no-explicit-any
      .map((e: any) => e?.node).filter((n: DistNode | null) => n != null)
    const pageInfo = data?.searchDistributions?.pageInfo
    const endCursor: string | null = pageInfo?.endCursor ?? null
    const hasNextPage: boolean = pageInfo?.hasNextPage === true

    if (nodes.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { message: "empty page", elapsed_ms: Date.now() - started, function_version: 2, has_next_page: false },
        cursorBefore: cursor, cursorAfter: endCursor,
      })
      return
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
    if (editionUuids.length > 0) {
      const { data: fmvRows, error: fmvErr } = await supabase.rpc("get_fmv_for_editions", {
        p_collection_id: GOLAZOS_COLLECTION_ID,
        p_edition_ids: editionUuids,
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
      pool_rows_written: 0, ev_rows_written: 0, single_edition_packs: 0,
      rpc_not_ok: 0, rpc_errors: 0, weighted_count: 0,
    }
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

      // supplyWeightPool (../_shared) is the pinned, unit-tested copy of this math.
      const weights = supplyWeightPool(pooledEditions.map(p => p.circ))
      poolRowsByDist[distId] = pooledEditions.map((p, i) => {
        const w = weights[i]
        return {
          collection_id: GOLAZOS_COLLECTION_ID,
          dist_id: distId,
          edition_id: p.edition_id,
          edition_flow_id: p.external_id,
          drop_weight: w, orig_drop_weight: w, slot_name: "default", pool_source: "gql",
          last_refreshed_at: new Date().toISOString(),
        }
      })
    }

    // === Phase 3: delete-then-insert pool rows per distribution ===
    for (const [distId, rows] of Object.entries(poolRowsByDist)) {
      await supabase.from("pack_drop_pool").delete()
        .eq("collection_id", GOLAZOS_COLLECTION_ID).eq("dist_id", distId)
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const { error: ie } = await supabase.from("pack_drop_pool").insert(chunk)
        if (!ie) counters.pool_rows_written += chunk.length
      }
    }

    // === Phase 4: compute supply-weighted EV per distribution via RPC ===
    const evRows: Array<Record<string, unknown>> = []
    for (const [distId, meta] of Object.entries(distMeta)) {
      const { node } = meta
      const slots = Math.max(1, node.numberOfPackSlots ?? 1)
      const packPrice = node.price?.value ? Number(node.price.value) : 0

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

      const total = node.totalSupply ?? 0
      const available = node.availableSupply ?? 0
      const depletionPct = computeDepletionPct(total, available)

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
        total_unopened: available,
        depletion_pct: depletionPct,
      })
    }

    // === Phase 5: bulk insert EV history ===
    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (!evErr) counters.ev_rows_written = evRows.length
      else {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: nodes.length, rowsWritten: 0, rowsSkipped: nodes.length,
          ok: false, error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - started, function_version: 2 },
          cursorBefore: cursor, cursorAfter: endCursor,
        })
        return
      }
    }

    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: nodes.length,
      rowsWritten: counters.ev_rows_written,
      rowsSkipped: counters.nodes_no_editions + counters.nodes_no_fmv_coverage + counters.rpc_not_ok + counters.rpc_errors,
      ok: true,
      extra: {
        ...counters,
        editions_resolved: editionByExternalId.size,
        editions_with_fmv: fmvByEditionId.size,
        editions_requested: allExternalIds.size,
        elapsed_ms: elapsed,
        function_version: 2,
        ev_method: "circulation_weighted",
        has_next_page: hasNextPage,
      },
      cursorBefore: cursor, cursorAfter: endCursor,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-golazos-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: 2 },
      cursorBefore: cursor,
    })
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  const auth = req.headers.get("Authorization") ?? ""
  const keyParam = url.searchParams.get("key")
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}` && !gateKeyOk(keyParam)) {
    return new Response("Unauthorized", { status: 401 })
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
