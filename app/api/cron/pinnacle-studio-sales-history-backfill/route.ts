import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ─────────────────────────────────────────────────────────────────────────────
// Disney Pinnacle sales-history backfill via the Dapper studio-platform GQL.
//
// Discovery: docs/handoff-2026-06-24-studio-platform-gql-deep-history.md
//
// Pinnacle sales live in pinnacle_sales (render-keyed), NOT the shared `sales`
// table — so this is a bespoke drain (the AllDay/Golazos shared helper writes
// `sales`). pinnacle_sales currently only goes back to 2026-02-28 (the forward
// on-chain indexer's start), but Pinnacle launched ~2024 — so the entire
// pre-2026-02-28 secondary history is missing. studio indexes it fully (Pinnacle
// is wholly inside the studio window), so this is the single highest-value tail.
//
// KEYING (matches the established pinnacle_sales convention):
//   • render_id    = the true per-pin key (Pinnacle FMV keys on it) — from the
//                    queue (pinnacle_catalog.render_id), confirmed by node.render_id.
//   • edition_id   = pinnacle_catalog.legacy_edition_key (set-level), as the
//                    existing rows store (NOT the studio numeric edition id).
//   • studio_edition_id (numeric) is ONLY the searchPinnacleMarketplaceHistory
//                    filter arg (== pinnacle_catalog.edition_id), 1:1 with render.
//   • id           = `${transaction_hash}_${nft_id}` (the existing PK convention)
//                    → idempotent dedup, augments the on-chain rows, never doubles.
//   • resolution_status = null + buyer from node.receiver_address (mirrors the
//                    existing history-backfill rows: render set, async-resolvable).
//
// SAFETY RAILS mirror the shared studio drain: synchronous, ~200s budget,
// self-throttle, dedup by id PK + 23505 fallback, source-tagged for one-DELETE
// revert. Kill switch: disable the cron OR set
//   PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED=1
// Revert: DELETE FROM pinnacle_sales WHERE source='pinnacle_studio_history_v1';
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "pinnacle-studio-sales-history-backfill"
const COLLECTION_SLUG = "disney_pinnacle"
const SOURCE_TAG = "pinnacle_studio_history_v1"
const PROGRESS_TABLE = "pinnacle_studio_sales_history_progress"
const SEED_FN = "seed_pinnacle_studio_sales_history_targets"
const DISABLE_ENV = "PINNACLE_STUDIO_SALES_HISTORY_BACKFILL_DISABLED"

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  Origin: "https://disneypinnacle.com",
  Referer: "https://disneypinnacle.com/",
}

const RENDERS_PER_TICK = 200
const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 260_000
const PAGE_SIZE = 100
const MAX_PAGES = 12
const PER_REQUEST_TIMEOUT_MS = 20_000
const INTER_PAGE_DELAY_MS = 150
const INTER_RENDER_DELAY_MS = 120
const INSERT_CHUNK = 200
const READ_CHUNK = 200
const SATURATION_FAIL_THRESHOLD = 15
const MAX_ATTEMPTS = 4

const HISTORY_QUERY = `
query PinnacleHistory($in: SearchPinnacleMarketplaceHistoryInput!) {
  searchPinnacleMarketplaceHistory(searchInput: $in) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node {
      nft_id price sales_price purchased receiver_address
      created_at { block_time transaction_hash }
      nft { serial_number render_id }
    } }
  }
}`

interface HistNode {
  nft_id: string | null
  price: string | null
  sales_price: string | null
  purchased: boolean | null
  receiver_address: string | null
  created_at: { block_time: string | null; transaction_hash: string | null } | null
  nft: { serial_number: string | null; render_id: string | null } | null
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchPage(
  editionIdInt: number,
  after: string | null,
): Promise<{ total: number; nodes: HistNode[]; endCursor: string | null; hasNextPage: boolean }> {
  const variables: { in: { first: number; after?: string; filters: Array<{ edition_id: { eq: number } }> } } = {
    in: { first: PAGE_SIZE, filters: [{ edition_id: { eq: editionIdInt } }] },
  }
  if (after) variables.in.after = after
  const res = await fetch(GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({ query: HISTORY_QUERY, variables }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}`)
  const json = (await res.json()) as {
    data?: { searchPinnacleMarketplaceHistory?: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ node: HistNode }> } }
    errors?: Array<{ message: string }>
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`GQL: ${json.errors[0]?.message ?? "error"}`)
  const conn = json.data?.searchPinnacleMarketplaceHistory
  if (!conn) throw new Error("GQL: empty response")
  return {
    total: conn.totalCount ?? 0,
    nodes: (conn.edges ?? []).map((e) => e.node).filter(Boolean),
    endCursor: conn.pageInfo?.endCursor ?? null,
    hasNextPage: conn.pageInfo?.hasNextPage === true,
  }
}

type PinSaleRow = {
  id: string
  edition_id: string | null
  render_id: string
  nft_id: string | null
  sale_price_usd: number
  serial_number: number | null
  sold_at: string
  source: string
  created_at: string
  buyer_address: string | null
  seller_address: string | null
  resolution_status: string | null
}

type RenderResult = {
  status: "done" | "empty" | "error" | "pending"
  studioTotal: number
  found: number
  inserted: number
  dupes: number
  pages: number
  error: string | null
}

async function drainRender(
  renderId: string,
  studioEditionId: string,
  legacyKey: string | null,
  attempts: number,
  deadlineMs: number,
): Promise<RenderResult> {
  const editionIdInt = toNum(studioEditionId)
  if (editionIdInt === null) {
    return { status: "error", studioTotal: 0, found: 0, inserted: 0, dupes: 0, pages: 0, error: "non_numeric_edition_id" }
  }

  const candidates = new Map<string, PinSaleRow>() // dedup within batch by id
  const now = new Date().toISOString()
  let studioTotal = 0
  let found = 0
  let pages = 0
  let after: string | null = null

  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      if (Date.now() > deadlineMs) break
      const page = await fetchPage(editionIdInt, after)
      pages++
      studioTotal = Math.max(studioTotal, page.total)
      for (const n of page.nodes) {
        found++
        if (n.purchased !== true) continue
        const tx = n.created_at?.transaction_hash
        if (!tx) continue
        const soldAt = n.created_at?.block_time
        if (!soldAt) continue
        const nftId = n.nft_id ? String(n.nft_id) : null
        if (!nftId) continue
        const priceDuc = toNum(n.sales_price ?? n.price)
        if (priceDuc === null || priceDuc <= 0) continue
        const id = `${tx}_${nftId}`
        if (candidates.has(id)) continue
        candidates.set(id, {
          id,
          edition_id: legacyKey,
          render_id: n.nft?.render_id ?? renderId,
          nft_id: nftId,
          sale_price_usd: priceDuc / 1e8, // DUC UInt64 → USD
          serial_number: toNum(n.nft?.serial_number),
          sold_at: soldAt,
          source: SOURCE_TAG,
          created_at: now,
          buyer_address: n.receiver_address ?? null,
          seller_address: null,
          resolution_status: null,
        })
      }
      if (!page.hasNextPage) break
      after = page.endCursor
      if (!after) break
      await delay(INTER_PAGE_DELAY_MS)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { status: attempts + 1 >= MAX_ATTEMPTS ? "error" : "pending", studioTotal, found, inserted: 0, dupes: 0, pages, error: msg.slice(0, 180) }
  }

  if (candidates.size === 0) {
    return { status: "empty", studioTotal, found, inserted: 0, dupes: 0, pages, error: null }
  }

  // Pre-filter against existing pinnacle_sales by id (the `${tx}_${nft}` PK) —
  // catches overlap with the forward on-chain indexer + the on-chain backfill.
  const ids = Array.from(candidates.keys())
  const existing = new Set<string>()
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK)
    const { data, error } = await supabaseAdmin.from("pinnacle_sales").select("id").in("id", chunk)
    if (error) {
      return { status: attempts + 1 >= MAX_ATTEMPTS ? "error" : "pending", studioTotal, found, inserted: 0, dupes: 0, pages, error: `existing_read: ${error.message.slice(0, 160)}` }
    }
    for (const r of (data ?? []) as Array<{ id: string }>) existing.add(r.id)
  }

  const toInsert: PinSaleRow[] = []
  let dupes = 0
  for (const row of candidates.values()) {
    if (existing.has(row.id)) dupes++
    else toInsert.push(row)
  }
  if (toInsert.length === 0) {
    return { status: "done", studioTotal, found, inserted: 0, dupes, pages, error: null }
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK)
    const { error } = await supabaseAdmin.from("pinnacle_sales").insert(chunk)
    if (!error) {
      inserted += chunk.length
      continue
    }
    if (error.code === "23505" || error.message.includes("duplicate")) {
      for (const row of chunk) {
        const { error: rowErr } = await supabaseAdmin.from("pinnacle_sales").insert(row)
        if (!rowErr) inserted++
        else if (rowErr.code === "23505" || rowErr.message.includes("duplicate")) dupes++
        else return { status: attempts + 1 >= MAX_ATTEMPTS ? "error" : "pending", studioTotal, found, inserted, dupes, pages, error: `insert: ${rowErr.message.slice(0, 160)}` }
      }
      continue
    }
    return { status: attempts + 1 >= MAX_ATTEMPTS ? "error" : "pending", studioTotal, found, inserted, dupes, pages, error: `insert: ${error.message.slice(0, 160)}` }
  }
  return { status: "done", studioTotal, found, inserted, dupes, pages, error: null }
}

async function logRun(
  startedAt: string,
  startedMs: number,
  ok: boolean,
  found: number,
  written: number,
  skipped: number,
  errMsg: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: COLLECTION_SLUG,
      p_extra: { ...extra, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
  const CRON = process.env.CRON_SECRET ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  if (process.env[DISABLE_ENV] === "1" || process.env[DISABLE_ENV] === "true") {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const seed = req.nextUrl.searchParams.get("seed") === "true"
  const probeKey = req.nextUrl.searchParams.get("edition")

  if (seed) {
    try {
      const { data, error } = await supabaseAdmin.rpc(SEED_FN)
      if (error) {
        await logRun(startedAt, startedMs, false, 0, 0, 0, error.message, { mode: "seed" })
        return NextResponse.json({ ok: false, mode: "seed", error: error.message }, { status: 500 })
      }
      const seeded = Number(data ?? 0)
      await logRun(startedAt, startedMs, true, seeded, 0, 0, null, { mode: "seed", seeded })
      return NextResponse.json({ ok: true, mode: "seed", seeded }, { status: 200 })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await logRun(startedAt, startedMs, false, 0, 0, 0, msg, { mode: "seed" })
      return NextResponse.json({ ok: false, mode: "seed", error: msg }, { status: 500 })
    }
  }

  if (dryRun) {
    const idInt = toNum(probeKey)
    if (idInt === null) return NextResponse.json({ ok: false, error: "dryRun needs &edition=<numeric studio edition id>" }, { status: 400 })
    try {
      let after: string | null = null
      let pages = 0
      let total = 0
      let scanned = 0
      const sample: Array<{ price: number | null; soldAt: string | null; render: string | null; tx: boolean }> = []
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchPage(idInt, after)
        pages++
        total = Math.max(total, page.total)
        scanned += page.nodes.length
        for (const n of page.nodes) {
          if (sample.length < 5) sample.push({ price: toNum(n.sales_price ?? n.price), soldAt: n.created_at?.block_time ?? null, render: n.nft?.render_id ?? null, tx: !!n.created_at?.transaction_hash })
        }
        if (!page.hasNextPage || !page.endCursor) break
        after = page.endCursor
        await delay(INTER_PAGE_DELAY_MS)
      }
      return NextResponse.json({ ok: true, mode: "dryRun", edition: idInt, studio_total: total, pages, scanned, sample }, { status: 200 })
    } catch (e) {
      return NextResponse.json({ ok: false, mode: "dryRun", edition: idInt, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  // ── Self-throttle ────────────────────────────────────────────────────────────
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { count } = await supabaseAdmin
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true })
      .eq("ok", false)
      .neq("pipeline", PIPELINE_NAME)
      .gte("finished_at", since)
    if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) {
      await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "saturation", recent_fails: count })
      return NextResponse.json({ ok: true, skipped: "saturation", recent_fails: count, pipeline: PIPELINE_NAME }, { status: 200 })
    }
  } catch (e) {
    await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, {})
    return NextResponse.json({ ok: false, skipped: "throttle_error", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  // ── Pick the next batch of pending renders ──────────────────────────────────
  const { data: targets, error: pickErr } = await supabaseAdmin
    .from(PROGRESS_TABLE)
    .select("render_id, studio_edition_id, legacy_edition_key, attempts")
    .eq("status", "pending")
    .order("priority", { ascending: true })
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(RENDERS_PER_TICK)

  if (pickErr) {
    await logRun(startedAt, startedMs, false, 0, 0, 0, `pick: ${pickErr.message}`, {})
    return NextResponse.json({ ok: false, error: pickErr.message, pipeline: PIPELINE_NAME }, { status: 500 })
  }
  if (!targets || targets.length === 0) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { note: "queue_empty" })
    return NextResponse.json({ ok: true, note: "queue_empty", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const hardDeadlineMs = startedMs + HARD_CAP_MS
  let totalFound = 0
  let totalInserted = 0
  let totalDupes = 0
  let rendersDone = 0
  let rendersEmpty = 0
  let rendersError = 0
  let gqlErrors = 0
  let budgetHit = false
  let processed = 0

  for (const t of targets as Array<{ render_id: string; studio_edition_id: string; legacy_edition_key: string | null; attempts: number }>) {
    if (Date.now() - startedMs > ELAPSED_BUDGET_MS) {
      budgetHit = true
      break
    }
    processed++
    const res = await drainRender(t.render_id, t.studio_edition_id, t.legacy_edition_key, t.attempts, hardDeadlineMs)
    totalFound += res.found
    totalInserted += res.inserted
    totalDupes += res.dupes
    if (res.status === "done") rendersDone++
    else if (res.status === "empty") rendersEmpty++
    else if (res.status === "error") rendersError++
    if (res.error && res.status !== "done" && res.status !== "empty") gqlErrors++

    const { error: upErr } = await supabaseAdmin
      .from(PROGRESS_TABLE)
      .update({
        status: res.status,
        attempts: t.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        sales_inserted: res.inserted,
        dupes_skipped: res.dupes,
        studio_total: res.studioTotal,
        gql_pages: res.pages,
        error: res.error,
        updated_at: new Date().toISOString(),
      })
      .eq("render_id", t.render_id)
    if (upErr) console.log(`[${PIPELINE_NAME}] progress update err for ${t.render_id}: ${upErr.message}`)

    await delay(INTER_RENDER_DELAY_MS)
  }

  let pendingRemaining: number | null = null
  try {
    const { count } = await supabaseAdmin.from(PROGRESS_TABLE).select("render_id", { count: "exact", head: true }).eq("status", "pending")
    pendingRemaining = count ?? null
  } catch {
    /* non-fatal */
  }

  await logRun(startedAt, startedMs, true, totalFound, totalInserted, totalDupes, null, {
    renders_processed: processed,
    renders_drained: rendersDone,
    renders_empty: rendersEmpty,
    renders_error: rendersError,
    gql_errors: gqlErrors,
    budget_hit: budgetHit,
    pending_remaining: pendingRemaining,
  })

  return NextResponse.json(
    {
      ok: true,
      pipeline: PIPELINE_NAME,
      renders_processed: processed,
      sales_inserted: totalInserted,
      dupes_skipped: totalDupes,
      renders_drained: rendersDone,
      renders_empty: rendersEmpty,
      renders_error: rendersError,
      gql_errors: gqlErrors,
      budget_hit: budgetHit,
      pending_remaining: pendingRemaining,
    },
    { status: 200 },
  )
}

export async function POST(req: NextRequest) {
  return run(req)
}
export async function GET(req: NextRequest) {
  return run(req)
}
