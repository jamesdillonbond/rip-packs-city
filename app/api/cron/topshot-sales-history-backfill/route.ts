import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// ─────────────────────────────────────────────────────────────────────────────
// TopShot sales-history backfill — closes the ASK_ONLY sales-ingest gap.
//
// Handoff: docs/handoff-2026-06-11-askonly-phase2-greenlight.md
// Plan:    docs/proposals/ts-sales-ingest-gap-backfill-2026-06-11.md
//
// ASK_ONLY is, to first approximation, the bucket of TS editions whose real
// sales we never ingested (784 int-keyed ASK_ONLY editions have ZERO rows in
// `sales`; LiveToken values them off deep history). This route walks
// searchMarketplaceTransactions per target edition (via the SAME proxied
// transport the live ingest route uses) and inserts the missing historical
// sales. fmv-recalc's normal sweep then re-labels them off real sales.
//
// DESIGN (overnight-safety rails — see handoff):
//  • SYNCHRONOUS, ≤~22s wall-clock. No after()/waitUntil — those tails die
//    silently on Vercel (memory: vercel-after-finally-unreliable). GHA waits
//    up to 600s (curl --max-time 600), so it sees the real status.
//  • Self-throttle: if >15 pipeline_runs fails in the last 30 min, skip the
//    tick. The backfill must never compound a saturated window.
//  • Idempotent: pre-filter against existing sales by txHash; insert with a
//    23505 row-by-row fallback (the partial unique indexes can't be inferred
//    by PostgREST onConflict, so plain insert is the proven path).
//  • UUID footgun: targets are already canonical int-keyed editions. We pull
//    sales for a KNOWN edition_id and verify each tx's int-key matches before
//    attributing it. We create ZERO editions and never key off a UUID pair.
//  • Tagged source='ts_history_backfill_v1' → revert is one DELETE.
//
// Kill switch: disable the GHA workflow (one commit) OR set env
//   TS_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 120 // ceiling; the loop self-budgets to ~22s

const PIPELINE_NAME = "topshot-sales-history-backfill"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const SOURCE_TAG = "ts_history_backfill_v1"

// Pacing / safety knobs (overnight, IO convalescing)
const EDITIONS_PER_TICK = 15
const ELAPSED_BUDGET_MS = 22_000
const PAGE_LIMIT = 50
const MAX_PAGES = 12 // ≤600 sales/edition — illiquid targets have far fewer
const INSERT_CHUNK = 400
const SATURATION_FAIL_THRESHOLD = 15
const MAX_EDITION_ATTEMPTS = 4

// ── GraphQL ──────────────────────────────────────────────────────────────────
// Same MarketplaceTransaction shape the live ingest route selects, filtered to
// a single edition via byEditions (integer setID/playID — the form the
// truth-probe already uses against this endpoint).
const EDITION_TRANSACTIONS_QUERY = `
  query EditionSalesHistory($input: SearchMarketplaceTransactionsInput!) {
    searchMarketplaceTransactions(input: $input) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MarketplaceTransactions {
              size
              data {
                ... on MarketplaceTransaction {
                  id
                  price
                  updatedAt
                  txHash
                  moment {
                    flowId
                    flowSerialNumber
                    set { flowId }
                    play { flowID }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`

type EditionTx = {
  id: string
  price: number | null
  updatedAt: string | null
  txHash: string | null
  moment: {
    flowId: string | null
    flowSerialNumber: string | number | null
    set: { flowId: string | number | null } | null
    play: { flowID: string | number | null } | null
  } | null
}

type TxResponse = {
  searchMarketplaceTransactions?: {
    data?: {
      searchSummary?: {
        pagination?: { rightCursor?: string | null }
        data?: unknown
      }
    }
  }
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Verify a tx belongs to the target edition via its on-chain int pair. Never
// keys off the GQL UUID pair (the writer-dupe footgun). Returns the int key
// "setID:playID" or null when the on-chain ids are missing/non-numeric.
function txIntKey(tx: EditionTx): string | null {
  const setRaw = tx.moment?.set?.flowId ?? null
  const playRaw = tx.moment?.play?.flowID ?? null
  if (setRaw == null || playRaw == null) return null
  const s = Number(setRaw)
  const p = Number(playRaw)
  if (!Number.isFinite(s) || !Number.isFinite(p)) return null
  return `${parseInt(String(setRaw), 10)}:${parseInt(String(playRaw), 10)}`
}

function extractTransactions(data: TxResponse | null): {
  txs: EditionTx[]
  nextCursor: string | null
} {
  const summary = data?.searchMarketplaceTransactions?.data?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null
  const txs: EditionTx[] = []
  const dataField = summary?.data as unknown
  if (Array.isArray(dataField)) {
    for (const block of dataField) {
      const b = block as { data?: EditionTx[] }
      if (Array.isArray(b?.data)) txs.push(...b.data)
    }
  } else if (dataField && typeof dataField === "object") {
    const b = dataField as { data?: EditionTx[] }
    if (Array.isArray(b.data)) txs.push(...b.data)
  }
  return { txs, nextCursor }
}

async function fetchEditionPage(
  setId: string,
  playId: string,
  cursor: string | null,
): Promise<{ txs: EditionTx[]; nextCursor: string | null }> {
  const data = await topshotGraphql<TxResponse>(EDITION_TRANSACTIONS_QUERY, {
    input: {
      sortBy: "UPDATED_AT_DESC",
      filters: { byEditions: [{ setID: setId, playID: playId }] },
      searchInput: {
        pagination: { cursor: cursor ?? "", direction: "RIGHT", limit: PAGE_LIMIT },
      },
    },
  })
  return extractTransactions(data)
}

type SaleRow = {
  edition_id: string
  collection_id: string
  collection: string
  serial_number: number
  price_usd: number
  currency: string
  marketplace: string
  source: string
  transaction_hash: string
  sold_at: string
  nft_id: string | null
}

type EditionResult = {
  status: "done" | "empty" | "error" | "pending"
  found: number
  inserted: number
  dupes: number
  pages: number
  error: string | null
}

// Drain one edition: walk all marketplace transactions, dedup against existing
// sales, insert the remainder. Resilient — a GQL throw marks the edition for a
// bounded retry instead of failing the whole tick.
async function drainEdition(
  editionId: string,
  editionKey: string,
  attempts: number,
): Promise<EditionResult> {
  const [setId, playId] = editionKey.split(":")
  if (!setId || !playId) {
    return { status: "error", found: 0, inserted: 0, dupes: 0, pages: 0, error: "unparseable_edition_key" }
  }

  // Walk pages
  const candidates = new Map<string, SaleRow>() // keyed by txHash (dedup within batch)
  let pages = 0
  let cursor: string | null = null
  let found = 0
  let synthSeq = 0
  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const { txs, nextCursor } = await fetchEditionPage(setId, playId, cursor)
      pages++
      if (txs.length === 0) break

      for (const tx of txs) {
        found++
        // Verify the tx belongs to this exact edition (int-key match). If the
        // on-chain ids are present and disagree, skip — defends against the API
        // returning a sibling/parallel edition.
        const k = txIntKey(tx)
        if (k !== null && k !== editionKey) continue

        const price = toNum(tx.price)
        if (price === null || price <= 0) continue
        const soldAt = tx.updatedAt
        if (!soldAt) continue

        const serial = toNum(tx.moment?.flowSerialNumber)
        const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

        // Prefer the real Flow tx hash. When absent, synthesize a DETERMINISTIC
        // hash so re-runs dedup against themselves (idempotent). Include serial
        // + epoch + a sequence so distinct sales never collide.
        let txHash = tx.txHash && tx.txHash.length > 0 ? tx.txHash : null
        if (!txHash) {
          const epoch = Math.floor(new Date(soldAt).getTime() / 1000)
          txHash = `tshist:${editionKey}:${serial ?? 0}:${epoch}:${synthSeq++}`
        }
        if (candidates.has(txHash)) continue

        candidates.set(txHash, {
          edition_id: editionId,
          collection_id: TS_COLLECTION_ID,
          collection: "nba_top_shot",
          serial_number: serial ?? 0,
          price_usd: price,
          currency: "USD",
          marketplace: "topshot",
          source: SOURCE_TAG,
          transaction_hash: txHash,
          sold_at: soldAt,
          nft_id: nftId,
        })
      }

      cursor = nextCursor
      if (!cursor) break
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Transient GQL failure → bounded retry next tick.
    return {
      status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
      found,
      inserted: 0,
      dupes: 0,
      pages,
      error: `gql: ${msg.slice(0, 240)}`,
    }
  }

  if (candidates.size === 0) {
    return { status: "empty", found, inserted: 0, dupes: 0, pages, error: null }
  }

  // Pre-filter against existing sales for this edition (zero-sales targets, so
  // usually empty). Dedup primarily by txHash.
  const { data: existing, error: exErr } = await supabaseAdmin
    .from("sales")
    .select("transaction_hash")
    .eq("edition_id", editionId)
  if (exErr) {
    return { status: "pending", found, inserted: 0, dupes: 0, pages, error: `existing_read: ${exErr.message.slice(0, 200)}` }
  }
  const existingHashes = new Set<string>(
    (existing ?? []).map((r: { transaction_hash: string | null }) => r.transaction_hash).filter(Boolean) as string[],
  )

  const toInsert: SaleRow[] = []
  let dupes = 0
  for (const row of candidates.values()) {
    if (existingHashes.has(row.transaction_hash)) {
      dupes++
      continue
    }
    toInsert.push(row)
  }

  if (toInsert.length === 0) {
    return { status: "done", found, inserted: 0, dupes, pages, error: null }
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK)
    const { error } = await supabaseAdmin.from("sales").insert(chunk)
    if (!error) {
      inserted += chunk.length
      continue
    }
    // Unique violation in the chunk → retry row-by-row (the proven dedup path;
    // partial unique indexes can't be inferred by onConflict).
    if (error.code === "23505" || error.message.includes("duplicate")) {
      for (const row of chunk) {
        const { error: rowErr } = await supabaseAdmin.from("sales").insert(row)
        if (!rowErr) inserted++
        else if (rowErr.code === "23505" || rowErr.message.includes("duplicate")) dupes++
        else {
          return { status: "pending", found, inserted, dupes, pages, error: `insert: ${rowErr.message.slice(0, 200)}` }
        }
      }
      continue
    }
    return { status: "pending", found, inserted, dupes, pages, error: `insert: ${error.message.slice(0, 200)}` }
  }

  return { status: "done", found, inserted, dupes, pages, error: null }
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
      p_collection_slug: "nba_top_shot",
      p_extra: { ...extra, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  // Kill switch (env). The GHA workflow toggle is the primary kill; this is the
  // belt-and-suspenders in-route flag.
  const disabled =
    process.env.TS_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.TS_SALES_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const seed = req.nextUrl.searchParams.get("seed") === "true"
  const probeKey = req.nextUrl.searchParams.get("edition") // dryRun single-edition probe

  // ── Seed mode: (re)materialize the target set into the progress table ──────
  if (seed) {
    try {
      const { data, error } = await supabaseAdmin.rpc("seed_topshot_sales_history_targets")
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

  // ── Dry-run probe: pull one edition's transactions, write NOTHING ──────────
  if (dryRun) {
    const key = probeKey ?? null
    if (!key || !/^\d+:\d+$/.test(key)) {
      return NextResponse.json({ ok: false, error: "dryRun needs &edition=setID:playID" }, { status: 400 })
    }
    const [s, p] = key.split(":")
    try {
      let cursor: string | null = null
      let pages = 0
      let total = 0
      const sample: Array<{ price: number | null; soldAt: string | null; serial: unknown; txHash: boolean; key: string | null }> = []
      for (let i = 0; i < MAX_PAGES; i++) {
        const { txs, nextCursor } = await fetchEditionPage(s, p, cursor)
        pages++
        total += txs.length
        for (const tx of txs.slice(0, 3)) {
          if (sample.length < 5) {
            sample.push({ price: toNum(tx.price), soldAt: tx.updatedAt, serial: tx.moment?.flowSerialNumber ?? null, txHash: !!tx.txHash, key: txIntKey(tx) })
          }
        }
        cursor = nextCursor
        if (txs.length === 0 || !cursor) break
      }
      return NextResponse.json({ ok: true, mode: "dryRun", edition: key, pages, total_txs: total, sample }, { status: 200 })
    } catch (e) {
      return NextResponse.json({ ok: false, mode: "dryRun", edition: key, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  // ── Self-throttle: bail if the platform is saturated ───────────────────────
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
    // If even the throttle read fails, the DB is unhappy — skip this tick.
    await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, { skipped: "throttle_error" })
    return NextResponse.json({ ok: false, skipped: "throttle_error", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  // ── Pick the next batch of pending targets (priority, oldest-attempt first) ─
  const { data: targets, error: pickErr } = await supabaseAdmin
    .from("topshot_sales_history_backfill_progress")
    .select("edition_id, edition_key, attempts")
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

  let totalFound = 0
  let totalInserted = 0
  let totalDupes = 0
  let editionsDone = 0
  let editionsEmpty = 0
  let editionsError = 0
  let gqlErrors = 0
  let budgetHit = false
  let processed = 0

  for (const t of targets as Array<{ edition_id: string; edition_key: string; attempts: number }>) {
    if (Date.now() - startedMs > ELAPSED_BUDGET_MS) {
      budgetHit = true
      break
    }
    processed++
    const res = await drainEdition(t.edition_id, t.edition_key, t.attempts)
    totalFound += res.found
    totalInserted += res.inserted
    totalDupes += res.dupes
    if (res.status === "done") editionsDone++
    else if (res.status === "empty") editionsEmpty++
    else if (res.status === "error") editionsError++
    if (res.error?.startsWith("gql:")) gqlErrors++

    const { error: upErr } = await supabaseAdmin
      .from("topshot_sales_history_backfill_progress")
      .update({
        status: res.status,
        attempts: t.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        sales_inserted: res.inserted,
        dupes_skipped: res.dupes,
        gql_pages: res.pages,
        error: res.error,
        updated_at: new Date().toISOString(),
      })
      .eq("edition_id", t.edition_id)
    if (upErr) {
      console.log(`[${PIPELINE_NAME}] progress update err for ${t.edition_id}: ${upErr.message}`)
    }
  }

  // Remaining pending count (cheap head read) for visibility.
  let pendingRemaining: number | null = null
  try {
    const { count } = await supabaseAdmin
      .from("topshot_sales_history_backfill_progress")
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
