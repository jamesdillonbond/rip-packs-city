import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// NFL All Day sales-history backfill via the Dapper studio-platform GraphQL.
//
// Discovery: docs/handoff-2026-06-24-studio-platform-gql-deep-history.md
//
// The forward allday-sales-indexer + the on-chain allday-sales-history-backfill
// only cover ~2025-12-29 → present (the current-spork window). The studio-platform
// GQL (api.production.studio-platform.dapperlabs.com — the SAME endpoint the green
// pinnacle-catalog / pack-listings routes already use, reachable unauthenticated
// from Vercel egress with an Origin header) indexes AllDay marketplace history
// back to ~2023-11. So this route fills the 2023-11 → 2026 coverage gap that the
// other two paths never captured — i.e. the ~1,809 fillable zero-sale editions in
// the queue. The ~473 pre-2023-11 (Series 1-2) editions return totalCount:0 and
// terminate as 'empty' (their deep tail is on-chain/spork-only — out of scope).
//
// KEYING: studio searchAllDayMarketplaceHistory filters on `edition_id` (Int),
// which == editions.external_id for AllDay. We attribute every sale to the KNOWN
// target edition_id (seeded from the queue) — ZERO edition creation, no mis-key.
//
// AUGMENTS, never replaces: some editions are deeper in our DB than studio
// (forward-captured) — dedup by transaction_hash keeps both sources; the on-chain
// route and this one cannot double-count.
//
// SAFETY RAILS (mirror topshot/allday sales-history-backfill):
//  • SYNCHRONOUS, no after()/waitUntil (those tails die silently on Vercel). The
//    platform's HARD ~300s response cap is the limiter; the loop self-budgets to
//    ~200s and each edition is page-capped, so loop+finalize returns under 300s.
//  • Self-throttle: >15 non-self pipeline_runs fails in last 30 min → skip the tick.
//  • Idempotent: dedup by transaction_hash against existing sales for the edition
//    + a 23505 row-by-row insert fallback (the per-partition unique index on
//    transaction_hash is the real backstop; onConflict can't infer it).
//  • Tagged source='allday_studio_history_v1' → revert is one DELETE.
//
// Kill switch: disable the Vercel cron (one edit) OR set env
//   ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300 // bounds runaway; the ~200s work-budget is the real limiter

const PIPELINE_NAME = "allday-studio-sales-history-backfill"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const COLLECTION_SLUG = "nfl_all_day"
const SOURCE_TAG = "allday_studio_history_v1"

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  Origin: "https://nflallday.com",
  Referer: "https://nflallday.com/",
}

// Pacing knobs. The synchronous response caps at a HARD ~300s. ELAPSED_BUDGET_MS
// is the real limiter (checked between editions); MAX_PAGES bounds any single
// edition (max observed ~185 sales = 2 pages of 100). EDITIONS_PER_TICK just
// keeps the count from binding before the time budget does.
const EDITIONS_PER_TICK = 200
const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 260_000
const PAGE_SIZE = 100
const MAX_PAGES = 12 // ≤1200 sales/edition — far above any real AllDay edition
const PER_REQUEST_TIMEOUT_MS = 20_000
const INTER_PAGE_DELAY_MS = 150 // gentle on studio (Cowork noted rapid manual probing can rate-limit)
const INTER_EDITION_DELAY_MS = 120
const INSERT_CHUNK = 200
const SATURATION_FAIL_THRESHOLD = 15
const MAX_EDITION_ATTEMPTS = 4

const HISTORY_QUERY = `
query AllDayHistory($in: SearchAllDayMarketplaceHistoryInput!) {
  searchAllDayMarketplaceHistory(searchInput: $in) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node {
      nft_id price sales_price purchased
      created_at { block_height block_time transaction_hash }
      nft { serial_number }
    } }
  }
}`

interface HistNode {
  nft_id: string | null
  price: string | null
  sales_price: string | null
  purchased: boolean | null
  created_at: { block_height: string | null; block_time: string | null; transaction_hash: string | null } | null
  nft: { serial_number: string | null } | null
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchHistoryPage(
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
    data?: {
      searchAllDayMarketplaceHistory?: {
        totalCount: number
        pageInfo: { endCursor: string | null; hasNextPage: boolean }
        edges: Array<{ node: HistNode }>
      }
    }
    errors?: Array<{ message: string }>
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`GQL: ${json.errors[0]?.message ?? "error"}`)
  const conn = json.data?.searchAllDayMarketplaceHistory
  if (!conn) throw new Error("GQL: empty response")
  return {
    total: conn.totalCount ?? 0,
    nodes: (conn.edges ?? []).map((e) => e.node).filter(Boolean),
    endCursor: conn.pageInfo?.endCursor ?? null,
    hasNextPage: conn.pageInfo?.hasNextPage === true,
  }
}

type SaleRow = {
  id: string
  edition_id: string
  collection_id: string
  collection: string
  nft_id: string | null
  serial_number: number
  price_usd: number
  currency: string
  marketplace: string
  source: string
  block_height: number | null
  transaction_hash: string
  sold_at: string
}

type EditionResult = {
  status: "done" | "empty" | "error" | "pending"
  studioTotal: number
  found: number
  inserted: number
  dupes: number
  pages: number
  error: string | null
}

// Drain one target edition: page all studio history, dedup, insert.
async function drainEdition(
  editionId: string,
  externalId: string,
  attempts: number,
  deadlineMs: number,
): Promise<EditionResult> {
  const editionIdInt = toNum(externalId)
  if (editionIdInt === null) {
    return { status: "error", studioTotal: 0, found: 0, inserted: 0, dupes: 0, pages: 0, error: "non_numeric_external_id" }
  }

  const candidates = new Map<string, SaleRow>() // dedup within batch by tx hash
  let studioTotal = 0
  let found = 0
  let pages = 0
  let after: string | null = null
  const ingestedAt = new Date().toISOString()

  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      if (Date.now() > deadlineMs) break
      const page = await fetchHistoryPage(editionIdInt, after)
      pages++
      // studio's totalCount is per-page remaining (full count on page 1, then
      // decremented) — take the max so the recorded total is the true full count.
      studioTotal = Math.max(studioTotal, page.total)
      for (const n of page.nodes) {
        found++
        if (n.purchased !== true) continue
        const txHash = n.created_at?.transaction_hash
        if (!txHash) continue
        const soldAt = n.created_at?.block_time
        if (!soldAt) continue
        const priceDuc = toNum(n.sales_price ?? n.price)
        if (priceDuc === null || priceDuc <= 0) continue
        if (candidates.has(txHash)) continue
        const serial = toNum(n.nft?.serial_number)
        candidates.set(txHash, {
          id: crypto.randomUUID(),
          edition_id: editionId,
          collection_id: ALLDAY_COLLECTION_ID,
          collection: COLLECTION_SLUG,
          nft_id: n.nft_id ? String(n.nft_id) : null,
          serial_number: serial ?? 0,
          price_usd: priceDuc / 1e8, // DUC UInt64 → USD
          currency: "USD",
          marketplace: "nflallday",
          source: SOURCE_TAG,
          block_height: toNum(n.created_at?.block_height),
          transaction_hash: txHash,
          sold_at: soldAt,
        })
      }
      if (!page.hasNextPage) break
      after = page.endCursor
      if (!after) break
      await delay(INTER_PAGE_DELAY_MS)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
      studioTotal, found, inserted: 0, dupes: 0, pages, error: msg.slice(0, 180),
    }
  }

  if (candidates.size === 0) {
    return { status: "empty", studioTotal, found, inserted: 0, dupes: 0, pages, error: null }
  }

  // Pre-filter against existing sales for this edition (covers the on-chain
  // overlap). The per-partition unique index on transaction_hash is the backstop.
  const { data: existing, error: exErr } = await supabaseAdmin
    .from("sales")
    .select("transaction_hash")
    .eq("edition_id", editionId)
  if (exErr) {
    return {
      status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
      studioTotal, found, inserted: 0, dupes: 0, pages, error: `existing_read: ${exErr.message.slice(0, 160)}`,
    }
  }
  const existingHashes = new Set<string>(
    (existing ?? []).map((r: { transaction_hash: string | null }) => r.transaction_hash).filter(Boolean) as string[],
  )

  const toInsert: SaleRow[] = []
  let dupes = 0
  for (const row of candidates.values()) {
    if (existingHashes.has(row.transaction_hash)) dupes++
    else toInsert.push(row)
  }
  if (toInsert.length === 0) {
    return { status: "done", studioTotal, found, inserted: 0, dupes, pages, error: null }
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK)
    const { error } = await supabaseAdmin.from("sales").insert(chunk)
    if (!error) {
      inserted += chunk.length
      continue
    }
    if (error.code === "23505" || error.message.includes("duplicate")) {
      for (const row of chunk) {
        const { error: rowErr } = await supabaseAdmin.from("sales").insert(row)
        if (!rowErr) inserted++
        else if (rowErr.code === "23505" || rowErr.message.includes("duplicate")) dupes++
        else {
          return {
            status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
            studioTotal, found, inserted, dupes, pages, error: `insert: ${rowErr.message.slice(0, 160)}`,
          }
        }
      }
      continue
    }
    return {
      status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
      studioTotal, found, inserted, dupes, pages, error: `insert: ${error.message.slice(0, 160)}`,
    }
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
  // Auth: Bearer INGEST_SECRET_TOKEN (cron-job.org/GHA) OR Bearer CRON_SECRET
  // (Vercel cron — injected automatically). Both also accepted as ?token=.
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

  const disabled =
    process.env.ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.ALLDAY_STUDIO_SALES_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const seed = req.nextUrl.searchParams.get("seed") === "true"
  const probeKey = req.nextUrl.searchParams.get("edition")

  // ── Seed mode: refresh the queue from the targets view (idempotent) ──────────
  if (seed) {
    try {
      const { data, error } = await supabaseAdmin.rpc("seed_allday_studio_sales_history_targets")
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

  // ── Dry-run: probe one edition end-to-end, write NOTHING ─────────────────────
  if (dryRun) {
    const key = probeKey ?? null
    const idInt = toNum(key)
    if (idInt === null) {
      return NextResponse.json({ ok: false, error: "dryRun needs &edition=<numeric edition external_id>" }, { status: 400 })
    }
    try {
      let after: string | null = null
      let pages = 0
      let total = 0
      let scanned = 0
      const sample: Array<{ price: number | null; soldAt: string | null; serial: number | null; tx: boolean }> = []
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await fetchHistoryPage(idInt, after)
        pages++
        total = page.total
        scanned += page.nodes.length
        for (const n of page.nodes) {
          if (sample.length < 5)
            sample.push({
              price: toNum(n.sales_price ?? n.price),
              soldAt: n.created_at?.block_time ?? null,
              serial: toNum(n.nft?.serial_number),
              tx: !!n.created_at?.transaction_hash,
            })
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

  // ── Pick the next batch of pending targets ──────────────────────────────────
  const { data: targets, error: pickErr } = await supabaseAdmin
    .from("allday_studio_sales_history_progress")
    .select("edition_id, external_id, attempts")
    .eq("status", "pending")
    .order("priority", { ascending: true })
    .order("last_attempt_at", { ascending: true, nullsFirst: true })
    .limit(EDITIONS_PER_TICK)

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
  let editionsDone = 0
  let editionsEmpty = 0
  let editionsError = 0
  let gqlErrors = 0
  let budgetHit = false
  let processed = 0

  for (const t of targets as Array<{ edition_id: string; external_id: string; attempts: number }>) {
    if (Date.now() - startedMs > ELAPSED_BUDGET_MS) {
      budgetHit = true
      break
    }
    processed++
    const res = await drainEdition(t.edition_id, t.external_id, t.attempts, hardDeadlineMs)
    totalFound += res.found
    totalInserted += res.inserted
    totalDupes += res.dupes
    if (res.status === "done") editionsDone++
    else if (res.status === "empty") editionsEmpty++
    else if (res.status === "error") editionsError++
    if (res.error && res.status !== "done" && res.status !== "empty") gqlErrors++

    const { error: upErr } = await supabaseAdmin
      .from("allday_studio_sales_history_progress")
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
      .eq("edition_id", t.edition_id)
    if (upErr) console.log(`[${PIPELINE_NAME}] progress update err for ${t.edition_id}: ${upErr.message}`)

    await delay(INTER_EDITION_DELAY_MS)
  }

  let pendingRemaining: number | null = null
  try {
    const { count } = await supabaseAdmin
      .from("allday_studio_sales_history_progress")
      .select("edition_id", { count: "exact", head: true })
      .eq("status", "pending")
    pendingRemaining = count ?? null
  } catch {
    /* non-fatal */
  }

  await logRun(startedAt, startedMs, true, totalFound, totalInserted, totalDupes, null, {
    editions_processed: processed,
    editions_drained: editionsDone,
    editions_empty: editionsEmpty,
    editions_error: editionsError,
    gql_errors: gqlErrors,
    budget_hit: budgetHit,
    pending_remaining: pendingRemaining,
  })

  return NextResponse.json(
    {
      ok: true,
      pipeline: PIPELINE_NAME,
      editions_processed: processed,
      sales_inserted: totalInserted,
      dupes_skipped: totalDupes,
      editions_drained: editionsDone,
      editions_empty: editionsEmpty,
      editions_error: editionsError,
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
