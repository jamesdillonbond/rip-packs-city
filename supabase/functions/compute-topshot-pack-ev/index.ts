// compute-topshot-pack-ev v1 — cron-driven Top Shot pack EV pipeline.
//
// Mirrors the operational pattern of compute-allday-pack-ev (auth, fire-and-
// forget, log_pipeline_run, batch+RPC EV computation, bulk pack_ev_history
// insert) but uses a fundamentally different data source.
//
// AllDay pulls Studio Platform searchDistributions for editionIds + uniform
// drop_weight=1. Top Shot's Studio Platform packOdds field is empty in
// practice, so we use NBA Top Shot's *public* GraphQL API instead, which
// surfaces per-edition `remaining` counts inside getPackListing's paginated
// packEditionsV3. This gives us a real per-edition probability signal:
//   drop_weight = remaining / totalUnopened
// summed across editions in a distribution ≈ 1.0.
//
// Flow:
//   1. Pull top 10 TS distributions from topshot_pack_ev_targets (oldest /
//      never-scanned first).
//   2. For each, dynamic query → totalUnopened + remainingByTier; paginated
//      packEditionsV3 → full edition pool with `count`/`remaining`.
//   3. Bulk resolve edition pool to internal edition_id via
//      get_topshot_editions_by_setplay; seed missing editions for the next
//      cycle to pick up.
//   4. Bulk FMV via get_fmv_for_editions.
//   5. Per dist: delete-then-insert pool rows with drop_weight = remaining/total.
//   6. Per dist: call compute_pack_ev_per_edition_weighted RPC.
//   7. Bulk insert pack_ev_history with all batch rows in one call.
//   8. log_pipeline_run with full counters.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"
const BATCH_SIZE = 4
const MAX_EDITION_PAGES = 8
const TIME_BUDGET_MS = 110_000

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

const DYNAMIC_QUERY = `
  query GetPackListing_DynamicData($input: GetPackListingInput!) {
    getPackListing(input: $input) {
      data {
        id
        forSale
        isSoldOut
        remaining
        dropType
        packListingContentRemaining {
          unopened
          totalPackCount
          remainingByTier {
            common rare legendary ultimate fandom autograph anthology
          }
          originalCountsByTier {
            common rare legendary ultimate fandom autograph anthology
          }
        }
      }
    }
  }
`

const EDITIONS_QUERY = `
  query GetPackEditions($input: GetPackListingInput!, $after: ID) {
    getPackListing(input: $input) {
      data {
        packEditionsV3(after: $after) {
          pageInfo { endCursor hasNextPage }
          edges {
            node {
              count
              remaining
              edition {
                id
                tier
                set { id }
                play { id }
              }
            }
          }
        }
      }
    }
  }
`

interface DynamicData {
  getPackListing?: {
    data?: {
      packListingContentRemaining?: {
        unopened?: number
        totalPackCount?: number
      }
    }
  }
}

interface EditionNode {
  count: number
  remaining: number
  edition: {
    id: string
    tier: string
    set: { id: string } | null
    play: { id: string } | null
  }
}

interface EditionsResponse {
  getPackListing?: {
    data?: {
      packEditionsV3?: {
        pageInfo: { endCursor: string; hasNextPage: boolean }
        edges: Array<{ node: EditionNode }>
      }
    }
  }
}

interface TargetRow {
  dist_id: string
  pack_listing_uuid: string
  title: string | null
  tier: string | null
  slots: number | null
  retail_price_usd: string | number | null
}

async function gqlCall<T>(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await fetch(TOPSHOT_GRAPHQL, {
      method: "POST",
      headers: GQL_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, error: `fetch: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  const json = await res.json().catch(() => null) as
    | { data?: T; errors?: Array<{ message: string }> } | null
  if (!json) return { ok: false, error: "not-json" }
  if (json.errors?.length) return { ok: false, error: json.errors[0].message }
  return { ok: true, data: (json.data ?? {}) as T }
}

async function fetchAllEditions(packListingId: string): Promise<{
  ok: true
  editions: EditionNode[]
  pages: number
} | { ok: false; error: string; pages: number }> {
  const all: EditionNode[] = []
  let cursor: string | null = null
  let pages = 0

  while (pages < MAX_EDITION_PAGES) {
    pages++
    const r = await gqlCall<EditionsResponse>(EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })
    if (!r.ok) return { ok: false, error: r.error, pages }
    const conn = r.data?.getPackListing?.data?.packEditionsV3
    const edges = conn?.edges ?? []
    for (const e of edges) if (e?.node) all.push(e.node)
    if (conn?.pageInfo?.hasNextPage !== true) break
    cursor = conn.pageInfo.endCursor ?? null
    if (!cursor) break
  }

  return { ok: true, editions: all, pages }
}

async function logPipelineRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "compute-topshot-pack-ev",
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: "nba-top-shot",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch { /* ignore */ }
}

async function runBackgroundWork(startedAtIso: string, started: number) {
  const counters = {
    nodes_processed: 0,
    nodes_no_editions: 0,
    nodes_no_dynamic: 0,
    nodes_zero_unopened: 0,
    pool_rows_written: 0,
    fmv_resolved: 0,
    editions_resolved: 0,
    editions_seeded: 0,
    ev_rows_written: 0,
    rpc_not_ok: 0,
    rpc_errors: 0,
    trim_applied_count: 0,
    gql_errors: 0,
  }

  try {
    const { data: targets, error: targetsErr } = await supabase
      .from("topshot_pack_ev_targets")
      .select("dist_id, pack_listing_uuid, title, tier, slots, retail_price_usd")
      .order("last_ev_at", { ascending: true, nullsFirst: true })
      .limit(BATCH_SIZE)
    if (targetsErr) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: false, error: `targets: ${targetsErr.message}`,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 2 },
      })
      return
    }

    const targetRows = (targets ?? []) as TargetRow[]
    if (targetRows.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 2, message: "no targets" },
      })
      return
    }

    // Heartbeat: log a "started" row before any GQL so we can tell apart
    // "background never ran" from "background ran but errored mid-flight".
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        message: "heartbeat:started",
        target_count: targetRows.length,
        elapsed_ms: Date.now() - started,
        function_version: 2,
      },
    })

    // === Phase 1: per-distribution GQL fetches (sequential to avoid rate limits) ===
    type DistFetched = {
      target: TargetRow
      totalUnopened: number
      totalPackCount: number
      editions: EditionNode[]
    }
    const fetched: DistFetched[] = []
    const seenExternalIds = new Set<string>()

    for (const t of targetRows) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        console.log(`[compute-topshot-pack-ev] time budget reached after ${counters.nodes_processed} dists — bailing`)
        break
      }
      counters.nodes_processed++

      const dyn = await gqlCall<DynamicData>(DYNAMIC_QUERY, { input: { packListingId: t.pack_listing_uuid } })
      if (!dyn.ok) {
        counters.gql_errors++
        console.log(`[compute-topshot-pack-ev] dyn err dist=${t.dist_id}: ${dyn.error}`)
        continue
      }
      const cr = dyn.data?.getPackListing?.data?.packListingContentRemaining
      const totalUnopened = cr?.unopened ?? 0
      const totalPackCount = cr?.totalPackCount ?? 0
      if (!cr) {
        counters.nodes_no_dynamic++
        continue
      }
      if (totalUnopened === 0) {
        counters.nodes_zero_unopened++
        continue
      }

      const eds = await fetchAllEditions(t.pack_listing_uuid)
      if (!eds.ok) {
        counters.gql_errors++
        console.log(`[compute-topshot-pack-ev] eds err dist=${t.dist_id}: ${eds.error}`)
        continue
      }
      if (eds.editions.length === 0) {
        // Bundle / case pack — log and move on, no pool or EV row.
        counters.nodes_no_editions++
        console.log(`[compute-topshot-pack-ev] bundle dist=${t.dist_id} listing=${t.pack_listing_uuid}`)
        continue
      }

      for (const node of eds.editions) {
        const setId = node.edition.set?.id
        const playId = node.edition.play?.id
        if (setId && playId) seenExternalIds.add(`${setId}:${playId}`)
      }

      fetched.push({ target: t, totalUnopened, totalPackCount, editions: eds.editions })
    }

    if (fetched.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length,
        ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 2 },
      })
      return
    }

    // === Phase 2: bulk edition + FMV resolution ===
    const externalIdList = Array.from(seenExternalIds)
    const editionByExternalId = new Map<string, { id: string; tier: string | null }>()
    if (externalIdList.length > 0) {
      const { data: edRows, error: edErr } = await supabase.rpc(
        "get_topshot_editions_by_setplay",
        { p_keys: externalIdList },
      )
      if (edErr) throw new Error(`get_topshot_editions_by_setplay: ${edErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (edRows ?? []) as any[]) {
        editionByExternalId.set(String(r.external_id), { id: r.edition_id, tier: r.tier })
      }
    }
    counters.editions_resolved = editionByExternalId.size

    const editionUuids = Array.from(editionByExternalId.values()).map(v => v.id)
    const fmvByEditionId = new Map<string, number>()
    if (editionUuids.length > 0) {
      const { data: fmvRows, error: fmvErr } = await supabase.rpc("get_fmv_for_editions", {
        p_collection_id: TOPSHOT_COLLECTION_ID,
        p_edition_ids: editionUuids,
      })
      if (fmvErr) throw new Error(`get_fmv_for_editions: ${fmvErr.message}`)
      // deno-lint-ignore no-explicit-any
      for (const r of (fmvRows ?? []) as any[]) {
        if (r.fmv_usd != null) fmvByEditionId.set(String(r.edition_id), Number(r.fmv_usd))
      }
    }
    counters.fmv_resolved = fmvByEditionId.size

    // === Phase 3: seed unresolved editions (fire-and-forget for next cycle) ===
    const unseededExternalIds: string[] = []
    for (const ext of externalIdList) {
      if (!editionByExternalId.has(ext)) unseededExternalIds.push(ext)
    }
    if (unseededExternalIds.length > 0) {
      const seedRows = unseededExternalIds.map(ext => ({
        external_id: ext,
        collection_id: TOPSHOT_COLLECTION_ID,
      }))
      const { error: seedErr } = await supabase
        .from("editions")
        .upsert(seedRows, { onConflict: "external_id,collection_id", ignoreDuplicates: true })
      if (!seedErr) counters.editions_seeded = seedRows.length
      else console.log(`[compute-topshot-pack-ev] seed err: ${seedErr.message}`)
    }

    // === Phase 4: pool writes per distribution (delete-then-insert) ===
    const nowIso = new Date().toISOString()
    for (const f of fetched) {
      const distId = f.target.dist_id
      const poolRows: Array<Record<string, unknown>> = []
      for (const node of f.editions) {
        const setId = node.edition.set?.id
        const playId = node.edition.play?.id
        if (!setId || !playId) continue
        const ext = `${setId}:${playId}`
        const ed = editionByExternalId.get(ext)
        if (!ed) continue
        const weight = f.totalUnopened > 0 ? node.remaining / f.totalUnopened : 0
        poolRows.push({
          collection_id: TOPSHOT_COLLECTION_ID,
          dist_id: distId,
          edition_id: ed.id,
          edition_flow_id: ext,
          drop_weight: weight,
          slot_name: "default",
          pool_source: "gql",
          last_refreshed_at: nowIso,
        })
      }

      await supabase.from("pack_drop_pool")
        .delete()
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .eq("dist_id", distId)

      if (poolRows.length === 0) continue
      for (let i = 0; i < poolRows.length; i += 500) {
        const chunk = poolRows.slice(i, i + 500)
        const { error: ie } = await supabase.from("pack_drop_pool").insert(chunk)
        if (!ie) counters.pool_rows_written += chunk.length
        else console.log(`[compute-topshot-pack-ev] pool insert err dist=${distId}: ${ie.message}`)
      }
    }

    // === Phase 5: EV RPC per distribution, collect rows ===
    const evRows: Array<Record<string, unknown>> = []
    const clamp = (v: number) => Math.max(-10000, Math.min(1000000, v))
    for (const f of fetched) {
      const distId = f.target.dist_id
      const slots = Math.max(1, f.target.slots ?? 1)
      const packPrice = f.target.retail_price_usd != null ? Number(f.target.retail_price_usd) : 0

      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "compute_pack_ev_per_edition_weighted",
        {
          p_collection_id: TOPSHOT_COLLECTION_ID,
          p_dist_id: distId,
          p_pack_price: packPrice,
          p_slots: slots,
        },
      )
      if (rpcErr) {
        counters.rpc_errors++
        console.log(`[compute-topshot-pack-ev] rpc err dist=${distId}: ${rpcErr.message}`)
        continue
      }
      // deno-lint-ignore no-explicit-any
      const ev = rpcResult as any
      if (!ev || ev.ok !== true) {
        counters.rpc_not_ok++
        continue
      }
      if (ev.trim_applied === true) counters.trim_applied_count++

      const depletionPct = f.totalPackCount > 0
        ? Math.min(100, Math.max(0, Math.round(((f.totalPackCount - f.totalUnopened) / f.totalPackCount) * 100)))
        : null

      evRows.push({
        pack_listing_id: f.target.pack_listing_uuid,
        collection_id: TOPSHOT_COLLECTION_ID,
        dist_id: distId,
        pack_name: f.target.title,
        pack_price: packPrice,
        gross_ev: clamp(Number(ev.gross_ev)),
        pack_ev: clamp(Number(ev.pack_ev)),
        is_positive_ev: Boolean(ev.is_positive_ev),
        value_ratio: ev.value_ratio != null ? Number(ev.value_ratio) : null,
        fmv_coverage_pct: Number(ev.fmv_coverage_pct),
        edition_count: Math.min(Number(ev.edition_count), 32767),
        total_unopened: f.totalUnopened,
        depletion_pct: depletionPct,
      })
    }

    // === Phase 6: bulk insert pack_ev_history ===
    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (!evErr) counters.ev_rows_written = evRows.length
      else {
        await logPipelineRun({
          startedAt: startedAtIso,
          rowsFound: targetRows.length,
          rowsWritten: 0,
          rowsSkipped: targetRows.length,
          ok: false,
          error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - started, function_version: 2 },
        })
        return
      }
    }

    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso,
      rowsFound: targetRows.length,
      rowsWritten: counters.ev_rows_written,
      rowsSkipped: counters.nodes_no_editions
        + counters.nodes_no_dynamic
        + counters.nodes_zero_unopened
        + counters.gql_errors
        + counters.rpc_not_ok
        + counters.rpc_errors,
      ok: true,
      extra: {
        ...counters,
        editions_requested: seenExternalIds.size,
        elapsed_ms: elapsed,
        function_version: 2,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-topshot-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { counters, elapsed_ms: Date.now() - started, function_version: 2 },
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runBackgroundWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch((e) =>
      console.log(`waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      note: "Real results will appear in pipeline_runs within ~60-90s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
