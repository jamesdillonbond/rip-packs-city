// compute-topshot-pack-ev v3 — parallelized fetch + larger batch.
//
// v2 issue: sequential per-pack GraphQL meant 4 packs × up to 9 round-trips
// each, all serial. Drove ~24s total runtime and forced batch=4 to fit in
// EdgeRuntime.waitUntil's window. Drain rate ~24 dists/day vs 30-day target.
//
// v3 fixes by fanning out per-pack fetches with Promise.allSettled. Within
// a single pack, edition pagination stays sequential (cursor-dependent),
// but across packs the work runs in parallel. With network-bound work and
// ~6-9 sequential calls per pack, parallelism cuts total fetch time from
// O(packs × calls) to O(maxCallsPerPack).
//
// Bumping BATCH_SIZE to 8: even pessimistic 12s parallel fetch + 4s DB
// writes leaves room under TIME_BUDGET_MS. Expected drain rate ~48/day.
//
// Counter changes: dropped trim_applied_count (always 0 for this RPC —
// per-edition weighting doesn't trim). Added fetch_phase_ms and
// db_phase_ms for visibility into where time goes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"
const BATCH_SIZE = 8
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

// Per-pack outcome from the parallel fetch phase. Tagged union so we can
// categorize each result deterministically when accumulating counters.
type FetchOutcome =
  | { tag: "success"; target: TargetRow; totalUnopened: number; totalPackCount: number; editions: EditionNode[] }
  | { tag: "no_dynamic"; target: TargetRow }
  | { tag: "no_editions"; target: TargetRow }
  | { tag: "zero_unopened"; target: TargetRow }
  | { tag: "gql_error"; target: TargetRow; error: string }

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
  ok: true; editions: EditionNode[]
} | { ok: false; error: string }> {
  const all: EditionNode[] = []
  let cursor: string | null = null
  let pages = 0
  while (pages < MAX_EDITION_PAGES) {
    pages++
    const r = await gqlCall<EditionsResponse>(EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })
    if (!r.ok) return { ok: false, error: r.error }
    const conn = r.data?.getPackListing?.data?.packEditionsV3
    const edges = conn?.edges ?? []
    for (const e of edges) if (e?.node) all.push(e.node)
    if (conn?.pageInfo?.hasNextPage !== true) break
    cursor = conn.pageInfo.endCursor ?? null
    if (!cursor) break
  }
  return { ok: true, editions: all }
}

// Fetches a single pack's full data (dynamic + editions). Independent of
// other packs — safe to call N at a time via Promise.allSettled.
async function fetchOnePack(target: TargetRow): Promise<FetchOutcome> {
  const dyn = await gqlCall<DynamicData>(DYNAMIC_QUERY, {
    input: { packListingId: target.pack_listing_uuid },
  })
  if (!dyn.ok) return { tag: "gql_error", target, error: `dyn: ${dyn.error}` }

  const cr = dyn.data?.getPackListing?.data?.packListingContentRemaining
  if (!cr) return { tag: "no_dynamic", target }
  const totalUnopened = cr.unopened ?? 0
  const totalPackCount = cr.totalPackCount ?? 0
  if (totalUnopened === 0) return { tag: "zero_unopened", target }

  const eds = await fetchAllEditions(target.pack_listing_uuid)
  if (!eds.ok) return { tag: "gql_error", target, error: `eds: ${eds.error}` }
  if (eds.editions.length === 0) return { tag: "no_editions", target }

  return { tag: "success", target, totalUnopened, totalPackCount, editions: eds.editions }
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null; extra: Record<string, unknown>
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
      p_cursor_before: null, p_cursor_after: null,
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
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 3 },
      })
      return
    }

    const targetRows = (targets ?? []) as TargetRow[]
    if (targetRows.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 3, message: "no targets" },
      })
      return
    }

    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0, rowsSkipped: 0,
      ok: true,
      extra: {
        message: "heartbeat:started",
        target_count: targetRows.length,
        elapsed_ms: Date.now() - started,
        function_version: 3,
        batch_size: BATCH_SIZE,
      },
    })

    // === Phase 1: parallel fetch all packs ===
    const fetchStart = Date.now()
    const fetchResults = await Promise.allSettled(
      targetRows.map(t => fetchOnePack(t))
    )
    const fetchPhaseMs = Date.now() - fetchStart

    const fetched: Array<Extract<FetchOutcome, { tag: "success" }>> = []
    const seenExternalIds = new Set<string>()

    for (const r of fetchResults) {
      counters.nodes_processed++
      if (r.status === "rejected") {
        counters.gql_errors++
        console.log(`[compute-topshot-pack-ev] settled-rejected: ${r.reason}`)
        continue
      }
      const o = r.value
      switch (o.tag) {
        case "success":
          fetched.push(o)
          for (const node of o.editions) {
            const setId = node.edition.set?.id
            const playId = node.edition.play?.id
            if (setId && playId) seenExternalIds.add(`${setId}:${playId}`)
          }
          break
        case "no_dynamic":
          counters.nodes_no_dynamic++
          break
        case "no_editions":
          counters.nodes_no_editions++
          console.log(`[compute-topshot-pack-ev] bundle dist=${o.target.dist_id} listing=${o.target.pack_listing_uuid}`)
          break
        case "zero_unopened":
          counters.nodes_zero_unopened++
          break
        case "gql_error":
          counters.gql_errors++
          console.log(`[compute-topshot-pack-ev] gql err dist=${o.target.dist_id}: ${o.error}`)
          break
      }
    }

    if (fetched.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 3, fetch_phase_ms: fetchPhaseMs },
      })
      return
    }

    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log(`[compute-topshot-pack-ev] time budget exceeded after fetch phase`)
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: false, error: "time_budget_exceeded_after_fetch",
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 3, fetch_phase_ms: fetchPhaseMs },
      })
      return
    }

    // === Phase 2: bulk DB resolution (editions + FMV) ===
    const dbStart = Date.now()
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

    // Fire-and-forget seed any unseen externalIds for next cycle
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

    // === Phase 3: pool writes (one delete-then-insert per dist) ===
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

    // === Phase 4: per-dist EV computation via RPC ===
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

    if (evRows.length > 0) {
      const { error: evErr } = await supabase.from("pack_ev_history").insert(evRows)
      if (!evErr) counters.ev_rows_written = evRows.length
      else {
        await logPipelineRun({
          startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
          rowsSkipped: targetRows.length, ok: false,
          error: `insert pack_ev_history: ${evErr.message}`,
          extra: { counters, elapsed_ms: Date.now() - started, function_version: 3, fetch_phase_ms: fetchPhaseMs },
        })
        return
      }
    }

    const dbPhaseMs = Date.now() - dbStart
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
        fetch_phase_ms: fetchPhaseMs,
        db_phase_ms: dbPhaseMs,
        function_version: 3,
        batch_size: BATCH_SIZE,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-topshot-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { counters, elapsed_ms: Date.now() - started, function_version: 3 },
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
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
