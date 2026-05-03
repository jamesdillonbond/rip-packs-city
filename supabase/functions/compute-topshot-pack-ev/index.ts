// compute-topshot-pack-ev v10 — concurrency throttle + 429/1015 retry to
// unblock the topshot-proxy under Cloudflare Workers per-IP rate limits.
//
// v9 diagnostics confirmed both visible failure modes share one root cause:
//   • errors_sample showed every gql_error was HTTP 429 with body
//     "error code: 1015" (Cloudflare Workers per-IP rate limit on the
//     proxy worker, NOT upstream nbatopshot.com bot mitigation).
//   • rpc_not_ok_sample showed every rpc_not_ok was reason "pool_empty",
//     which means pack_drop_pool was never seeded — and the seeding step
//     depends on the same GetPackEditions GQL call that the 1015 throttle
//     blocks. So the 67% rpc_not_ok rate is the downstream effect of the
//     33% gql_error rate from prior runs.
//
// v10 fixes the throttle:
//   1. Outer pack loop is no longer all-12-in-parallel via Promise.allSettled.
//      Packs are processed in chunks of FETCH_CONCURRENCY (=3) with await
//      between chunks. Worst-case concurrent requests through topshot-proxy
//      drops from ~12-on-burst to ~3.
//   2. gqlCall retries on HTTP 429 with body containing "1015". Up to
//      MAX_1015_RETRIES (=3) attempts with RETRY_BACKOFF_MS (=2000) wait
//      between attempts. Each retry is logged to errors_sample with a
//      "retried_after_1015" marker so we can verify the fix is working
//      from telemetry alone.
//
// No changes to RPC handling — rpc_not_ok with reason "pool_empty" should
// self-resolve once the proxy stops dropping editions calls and the next
// few cron ticks finish seeding pack_drop_pool. No changes to cron
// schedule, proxy auth, or batch size.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TOPSHOT_GRAPHQL_DIRECT = "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_URL = Deno.env.get("TS_PROXY_URL") ?? ""
const TS_PROXY_SECRET = Deno.env.get("TS_PROXY_SECRET") ?? ""
const GQL_ENDPOINT = TS_PROXY_URL || TOPSHOT_GRAPHQL_DIRECT
const USING_PROXY = Boolean(TS_PROXY_URL && TS_PROXY_SECRET)
if (!USING_PROXY) {
  console.log(`[compute-topshot-pack-ev] WARN: proxy env not set (TS_PROXY_URL=${TS_PROXY_URL ? "set" : "missing"}, TS_PROXY_SECRET=${TS_PROXY_SECRET ? "set" : "missing"}). Falling back to direct GQL — Cloudflare may reject ~50% of requests.`)
}

const BATCH_SIZE = 12
const MAX_EDITION_PAGES = 8
const TIME_BUDGET_MS = 110_000
const ERRORS_SAMPLE_CAP = 12
const FETCH_CONCURRENCY = 3
const MAX_1015_RETRIES = 3
const RETRY_BACKOFF_MS = 2000

const retryEvents: Array<{
  op: string
  attempt: number
  status: number
  body: string
  marker: "retried_after_1015"
}> = []

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

const GQL_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}
if (USING_PROXY) GQL_HEADERS["X-Proxy-Secret"] = TS_PROXY_SECRET

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
const DYNAMIC_OP = "GetPackListing_DynamicData"

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
const EDITIONS_OP = "GetPackEditions"

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

interface GqlFailure {
  opName: string
  error: string
  status?: number
  body?: string
}

type FetchOutcome =
  | { tag: "success"; target: TargetRow; totalUnopened: number; totalPackCount: number; editions: EditionNode[] }
  | { tag: "no_dynamic"; target: TargetRow }
  | { tag: "no_editions"; target: TargetRow }
  | { tag: "zero_unopened"; target: TargetRow }
  | { tag: "gql_error"; target: TargetRow; failure: GqlFailure }

async function gqlCall<T>(
  opName: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ ok: true; data: T } | { ok: false; failure: GqlFailure }> {
  for (let attempt = 1; attempt <= MAX_1015_RETRIES; attempt++) {
    let res: Response
    try {
      res = await fetch(GQL_ENDPOINT, {
        method: "POST",
        headers: GQL_HEADERS,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      return {
        ok: false,
        failure: { opName, error: `fetch: ${err instanceof Error ? err.message : String(err)}` },
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const bodyTrimmed = body.slice(0, 500)
      const is1015 = res.status === 429 && body.includes("1015")
      if (is1015 && attempt < MAX_1015_RETRIES) {
        if (retryEvents.length < ERRORS_SAMPLE_CAP) {
          retryEvents.push({
            op: opName,
            attempt,
            status: res.status,
            body: bodyTrimmed,
            marker: "retried_after_1015",
          })
        }
        console.log(`[compute-topshot-pack-ev] 1015 retry op=${opName} attempt=${attempt}, sleeping ${RETRY_BACKOFF_MS}ms`)
        await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS))
        continue
      }
      return {
        ok: false,
        failure: { opName, error: `HTTP ${res.status}`, status: res.status, body: bodyTrimmed },
      }
    }
    const text = await res.text()
    let json:
      | { data?: T; errors?: Array<{ message: string }> }
      | null = null
    try { json = JSON.parse(text) } catch { json = null }
    if (!json) {
      return {
        ok: false,
        failure: { opName, error: "not-json", status: res.status, body: text.slice(0, 500) },
      }
    }
    if (json.errors?.length) {
      return {
        ok: false,
        failure: {
          opName,
          error: json.errors[0].message,
          status: res.status,
          body: JSON.stringify(json.errors).slice(0, 500),
        },
      }
    }
    return { ok: true, data: (json.data ?? {}) as T }
  }
  return {
    ok: false,
    failure: { opName, error: `HTTP 429 (1015) after ${MAX_1015_RETRIES} retries`, status: 429, body: "exhausted_1015_retries" },
  }
}

async function fetchAllEditions(packListingId: string): Promise<{
  ok: true; editions: EditionNode[]
} | { ok: false; failure: GqlFailure }> {
  const all: EditionNode[] = []
  let cursor: string | null = null
  let pages = 0
  while (pages < MAX_EDITION_PAGES) {
    pages++
    const r = await gqlCall<EditionsResponse>(EDITIONS_OP, EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })
    if (!r.ok) return { ok: false, failure: r.failure }
    const conn = r.data?.getPackListing?.data?.packEditionsV3
    const edges = conn?.edges ?? []
    for (const e of edges) if (e?.node) all.push(e.node)
    if (conn?.pageInfo?.hasNextPage !== true) break
    cursor = conn.pageInfo.endCursor ?? null
    if (!cursor) break
  }
  return { ok: true, editions: all }
}

async function fetchOnePack(target: TargetRow): Promise<FetchOutcome> {
  const dyn = await gqlCall<DynamicData>(DYNAMIC_OP, DYNAMIC_QUERY, {
    input: { packListingId: target.pack_listing_uuid },
  })
  if (!dyn.ok) return { tag: "gql_error", target, failure: dyn.failure }

  const cr = dyn.data?.getPackListing?.data?.packListingContentRemaining
  if (!cr) return { tag: "no_dynamic", target }
  const totalUnopened = cr.unopened ?? 0
  const totalPackCount = cr.totalPackCount ?? 0
  if (totalUnopened === 0) return { tag: "zero_unopened", target }

  const eds = await fetchAllEditions(target.pack_listing_uuid)
  if (!eds.ok) return { tag: "gql_error", target, failure: eds.failure }
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
  retryEvents.length = 0
  const counters = {
    nodes_processed: 0,
    nodes_no_editions: 0,
    nodes_no_dynamic: 0,
    nodes_zero_unopened: 0,
    pool_rows_written: 0,
    fmv_resolved: 0,
    editions_resolved: 0,
    editions_seeded: 0,
    editions_seed_updated: 0,
    editions_resolved_after_seed: 0,
    ev_rows_written: 0,
    rpc_not_ok: 0,
    rpc_errors: 0,
    gql_errors: 0,
  }

  const errorsSample: Array<{
    op: string
    flow_id: string
    dist_id: string
    error: string
    status?: number
    body?: string
  }> = []
  const rpcNotOkSample: Array<{
    dist_id: string
    pack_price: number
    slots: number
    payload: unknown
  }> = []

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
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 10, using_proxy: USING_PROXY },
      })
      return
    }

    const targetRows = (targets ?? []) as TargetRow[]
    if (targetRows.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true,
        extra: { counters, elapsed_ms: Date.now() - started, function_version: 10, using_proxy: USING_PROXY, message: "no targets" },
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
        function_version: 10,
        using_proxy: USING_PROXY,
        batch_size: BATCH_SIZE,
      },
    })

    const fetchStart = Date.now()
    const fetchResults: PromiseSettledResult<FetchOutcome>[] = []
    for (let i = 0; i < targetRows.length; i += FETCH_CONCURRENCY) {
      const chunk = targetRows.slice(i, i + FETCH_CONCURRENCY)
      const chunkResults = await Promise.allSettled(chunk.map(t => fetchOnePack(t)))
      fetchResults.push(...chunkResults)
    }
    const fetchPhaseMs = Date.now() - fetchStart

    const fetched: Array<Extract<FetchOutcome, { tag: "success" }>> = []
    const seenExternalIds = new Set<string>()

    for (const r of fetchResults) {
      counters.nodes_processed++
      if (r.status === "rejected") {
        counters.gql_errors++
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        if (errorsSample.length < ERRORS_SAMPLE_CAP) {
          errorsSample.push({
            op: "settled-rejected",
            flow_id: "",
            dist_id: "",
            error: reason.slice(0, 500),
          })
        }
        console.log(`[compute-topshot-pack-ev] settled-rejected: ${reason}`)
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
          if (errorsSample.length < ERRORS_SAMPLE_CAP) {
            errorsSample.push({
              op: o.failure.opName,
              flow_id: o.target.pack_listing_uuid,
              dist_id: o.target.dist_id,
              error: o.failure.error.slice(0, 500),
              status: o.failure.status,
              body: o.failure.body,
            })
          }
          console.log(`[compute-topshot-pack-ev] gql err op=${o.failure.opName} dist=${o.target.dist_id}: ${o.failure.error}`)
          break
      }
    }

    if (fetched.length === 0) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: true,
        extra: {
          counters,
          errors_sample: [...errorsSample, ...retryEvents],
          rpc_not_ok_sample: rpcNotOkSample,
          elapsed_ms: Date.now() - started,
          function_version: 10,
          using_proxy: USING_PROXY,
          fetch_phase_ms: fetchPhaseMs,
        },
      })
      return
    }

    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log(`[compute-topshot-pack-ev] time budget exceeded after fetch phase`)
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: targetRows.length, rowsWritten: 0,
        rowsSkipped: targetRows.length, ok: false, error: "time_budget_exceeded_after_fetch",
        extra: {
          counters,
          errors_sample: [...errorsSample, ...retryEvents],
          rpc_not_ok_sample: rpcNotOkSample,
          elapsed_ms: Date.now() - started,
          function_version: 10,
          using_proxy: USING_PROXY,
          fetch_phase_ms: fetchPhaseMs,
        },
      })
      return
    }

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

    const unseededExternalIds: string[] = []
    for (const ext of externalIdList) {
      if (!editionByExternalId.has(ext)) unseededExternalIds.push(ext)
    }
    if (unseededExternalIds.length > 0) {
      const { data: seedResult, error: seedErr } = await supabase.rpc(
        "seed_topshot_editions",
        { p_external_ids: unseededExternalIds },
      )
      if (seedErr) {
        console.log(`[compute-topshot-pack-ev] seed err: ${seedErr.message}`)
      } else if (seedResult) {
        // deno-lint-ignore no-explicit-any
        const sr = seedResult as any
        counters.editions_seeded = Number(sr.inserted ?? 0)
        counters.editions_seed_updated = Number(sr.updated ?? 0)
      }

      const { data: postSeedRows, error: postSeedErr } = await supabase.rpc(
        "get_topshot_editions_by_setplay",
        { p_keys: unseededExternalIds },
      )
      if (postSeedErr) {
        console.log(`[compute-topshot-pack-ev] re-resolve err: ${postSeedErr.message}`)
      } else {
        // deno-lint-ignore no-explicit-any
        for (const r of (postSeedRows ?? []) as any[]) {
          if (!editionByExternalId.has(String(r.external_id))) {
            editionByExternalId.set(String(r.external_id), { id: r.edition_id, tier: r.tier })
            counters.editions_resolved_after_seed++
          }
        }
      }
    }

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
        if (rpcNotOkSample.length < ERRORS_SAMPLE_CAP) {
          rpcNotOkSample.push({
            dist_id: distId,
            pack_price: packPrice,
            slots,
            payload: ev,
          })
        }
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
          extra: {
            counters,
            errors_sample: [...errorsSample, ...retryEvents],
            rpc_not_ok_sample: rpcNotOkSample,
            elapsed_ms: Date.now() - started,
            function_version: 10,
            using_proxy: USING_PROXY,
            fetch_phase_ms: fetchPhaseMs,
          },
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
        errors_sample: [...errorsSample, ...retryEvents],
        rpc_not_ok_sample: rpcNotOkSample,
        elapsed_ms: elapsed,
        fetch_phase_ms: fetchPhaseMs,
        db_phase_ms: dbPhaseMs,
        function_version: 10,
        using_proxy: USING_PROXY,
        batch_size: BATCH_SIZE,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[compute-topshot-pack-ev] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: {
        counters,
        errors_sample: [...errorsSample, ...retryEvents],
        rpc_not_ok_sample: rpcNotOkSample,
        elapsed_ms: Date.now() - started,
        function_version: 10,
        using_proxy: USING_PROXY,
      },
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
      using_proxy: USING_PROXY,
      note: "Real results will appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
