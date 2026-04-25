// app/api/flowty-tx-scanner/route.ts
//
// POST /api/flowty-tx-scanner   — Authorization: Bearer $INGEST_SECRET_TOKEN
//
// Block scanner that finds Flow transactions touching Flowty's NFTStorefrontV2
// fork (0x3cdbb3d569211ff3) or Dapper's NFTStorefrontV2 (0x4eb8a10cb9f87357),
// classifies failures via lib/flowty-tx-classifier, and writes both successes
// (lightweight rows for failure-rate baseline) and failures (full classified
// rows) into the flowty_transactions table.
//
// Scheduled by cron-job.org every 5 minutes.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  classifyError,
  inferCollection,
  inferCollectionFromEvents,
  detectStorefront,
  extractImportedAddresses,
} from "@/lib/flowty-tx-classifier"

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const FLOW_REST = "https://rest-mainnet.onflow.org"

const MAX_BLOCKS_PER_RUN = 600
const BLOCK_RANGE_CHUNK = 50
const PARALLEL_RESULT_FETCHES = 30
const PARALLEL_TX_FETCHES = 15
const FETCH_TIMEOUT_MS = 8_000
const INTER_CHUNK_DELAY_MS = 50
const SAFETY_LAG_BLOCKS = 5

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

async function fetchJSON<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }
  return (await res.json()) as T
}

async function pmap<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<Array<R | { __error: string }>> {
  const results: Array<R | { __error: string }> = new Array(items.length)
  let cursor = 0
  async function loop() {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await worker(items[i])
      } catch (err) {
        results[i] = { __error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => loop()),
  )
  return results
}

function isErr<T>(x: T | { __error: string }): x is { __error: string } {
  return Boolean(x && typeof x === "object" && "__error" in (x as object))
}

interface FlowBlock {
  header: { id: string; height: string; timestamp: string }
  payload?: { collection_guarantees?: Array<{ collection_id: string }> }
}

interface FlowCollection {
  id: string
  transactions?: Array<{ id: string }>
}

interface FlowTxResult {
  block_id: string
  status: string
  status_code: number
  error_message: string
  events?: Array<{ type: string; transaction_id: string }>
  computation_used?: string
  execution: "Success" | "Failure"
}

interface FlowTx {
  script: string
  payer: string
  proposal_key?: { address: string }
  authorizers?: string[]
}

function normAddr(a: string): string {
  if (!a) return a
  const s = a.toLowerCase().replace(/^0x/, "")
  return `0x${s.padStart(16, "0")}`
}

export async function POST(req: NextRequest) {
  if (!TOKEN || req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return unauthorized()
  }

  const t0 = Date.now()
  const counters = {
    blocksScanned: 0,
    txsScanned: 0,
    txsFlowtyImport: 0,
    txsFailed: 0,
    txsFailedFlowty: 0,
    rowsInserted: 0,
    errors: [] as string[],
  }

  try {
    const stateRes = await supabaseAdmin
      .from("flowty_scanner_state")
      .select("last_scanned_height")
      .eq("id", 1)
      .single()
    if (stateRes.error) throw stateRes.error

    const sealed = await fetchJSON<FlowBlock[]>(
      `${FLOW_REST}/v1/blocks?height=sealed`,
    )
    const sealedHeight = parseInt(sealed[0]?.header?.height ?? "0", 10)
    if (!sealedHeight) throw new Error("Could not determine sealed height")

    let startHeight = stateRes.data!.last_scanned_height + 1
    if (startHeight === 1) {
      startHeight = sealedHeight - 100
    }
    const endHeight = Math.min(
      sealedHeight - SAFETY_LAG_BLOCKS,
      startHeight + MAX_BLOCKS_PER_RUN - 1,
    )

    if (endHeight < startHeight) {
      return NextResponse.json({
        ok: true,
        message: "Caught up; nothing to scan",
        sealedHeight,
        last_scanned_height: stateRes.data!.last_scanned_height,
        elapsed_ms: Date.now() - t0,
      })
    }

    const blocks: FlowBlock[] = []
    for (let s = startHeight; s <= endHeight; s += BLOCK_RANGE_CHUNK) {
      const e = Math.min(s + BLOCK_RANGE_CHUNK - 1, endHeight)
      try {
        const chunk = await fetchJSON<FlowBlock[]>(
          `${FLOW_REST}/v1/blocks?start_height=${s}&end_height=${e}&expand=payload`,
        )
        blocks.push(...chunk)
      } catch (err) {
        counters.errors.push(`blocks ${s}-${e}: ${String(err)}`)
      }
      if (s + BLOCK_RANGE_CHUNK <= endHeight) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS))
      }
    }
    counters.blocksScanned = blocks.length

    const collectionIds = new Set<string>()
    for (const b of blocks) {
      for (const cg of b.payload?.collection_guarantees ?? []) {
        if (cg.collection_id) collectionIds.add(cg.collection_id)
      }
    }

    const collections = await pmap(
      Array.from(collectionIds),
      (id) =>
        fetchJSON<FlowCollection>(
          `${FLOW_REST}/v1/collections/${id}?expand=transactions`,
        ),
      PARALLEL_RESULT_FETCHES,
    )

    const txIds = new Set<string>()
    for (const c of collections) {
      if (isErr(c)) continue
      for (const t of c.transactions ?? []) {
        if (t.id) txIds.add(t.id)
      }
    }
    counters.txsScanned = txIds.size

    const txIdArray = Array.from(txIds)
    const results = await pmap(
      txIdArray,
      async (id) => {
        const r = await fetchJSON<FlowTxResult>(
          `${FLOW_REST}/v1/transaction_results/${id}`,
        )
        return { id, result: r }
      },
      PARALLEL_RESULT_FETCHES,
    )

    const candidates: Array<{
      id: string
      result: FlowTxResult
      isFailure: boolean
    }> = []

    for (const row of results) {
      if (isErr(row)) continue
      const { id, result } = row
      if (!result || !result.execution) continue
      const isFailure = result.execution === "Failure"
      if (isFailure) {
        counters.txsFailed++
        candidates.push({ id, result, isFailure: true })
      } else {
        const hasFlowtyEvent = (result.events ?? []).some((e) =>
          /A\.(3cdbb3d569211ff3|4eb8a10cb9f87357)\.NFTStorefrontV2\./i.test(e.type),
        )
        if (hasFlowtyEvent) {
          candidates.push({ id, result, isFailure: false })
        }
      }
    }

    const detailed = await pmap(
      candidates,
      async (c) => {
        const tx = await fetchJSON<FlowTx>(`${FLOW_REST}/v1/transactions/${c.id}`)
        const script = Buffer.from(tx.script ?? "", "base64").toString("utf8")
        const storefront = detectStorefront(script)
        return { ...c, tx, script, storefront }
      },
      PARALLEL_TX_FETCHES,
    )

    type Row = {
      tx_hash: string
      block_height: number
      block_id: string
      sealed_at: string
      status: "success" | "failure"
      status_code: number | null
      error_message: string | null
      payer: string
      proposer: string
      authorizers: string[]
      failure_category: string | null
      failure_subcategory: string | null
      collection: string | null
      storefront_addr: string | null
      contracts_imported: string[]
      computation_used: number | null
      raw_result: unknown
      classified_at: string
    }

    const rows: Row[] = []
    const blockByID = new Map<string, FlowBlock>()
    for (const b of blocks) {
      blockByID.set(b.header.id, b)
    }

    for (const d of detailed) {
      if (isErr(d)) continue
      const { id, result, isFailure, tx, script, storefront } = d

      if (!storefront) continue

      counters.txsFlowtyImport++
      if (isFailure) counters.txsFailedFlowty++

      const blk = blockByID.get(result.block_id)
      const blockHeight = blk ? parseInt(blk.header.height, 10) : 0
      const sealedAt = blk ? blk.header.timestamp : new Date().toISOString()

      const classification = isFailure
        ? classifyError(result.error_message)
        : { category: null as string | null, subcategory: null as string | null }

      rows.push({
        tx_hash: id,
        block_height: blockHeight,
        block_id: result.block_id,
        sealed_at: sealedAt,
        status: isFailure ? "failure" : "success",
        status_code: result.status_code ?? null,
        error_message: isFailure ? (result.error_message ?? null) : null,
        payer: normAddr(tx.payer ?? ""),
        proposer: normAddr(tx.proposal_key?.address ?? tx.payer ?? ""),
        authorizers: (tx.authorizers ?? []).map(normAddr),
        failure_category: classification.category,
        failure_subcategory: classification.subcategory,
        collection:
          inferCollectionFromEvents(result.events) !== "unknown"
            ? inferCollectionFromEvents(result.events)
            : inferCollection(script),
        storefront_addr: storefront,
        contracts_imported: extractImportedAddresses(script),
        computation_used: result.computation_used
          ? parseInt(result.computation_used, 10)
          : null,
        raw_result: isFailure ? result : null,
        classified_at: new Date().toISOString(),
      })
    }

    if (rows.length > 0) {
      const ins = await supabaseAdmin
        .from("flowty_transactions")
        .upsert(rows, { onConflict: "tx_hash" })
      if (ins.error) {
        counters.errors.push(`upsert: ${ins.error.message}`)
      } else {
        counters.rowsInserted = rows.length
      }
    }

    const elapsed = Date.now() - t0
    const updateRes = await supabaseAdmin
      .from("flowty_scanner_state")
      .update({
        last_scanned_height: endHeight,
        last_run_at: new Date().toISOString(),
        last_run_duration_ms: elapsed,
        last_run_blocks_scanned: counters.blocksScanned,
        last_run_txs_scanned: counters.txsScanned,
        last_run_failures_found: counters.txsFailedFlowty,
      })
      .eq("id", 1)
    if (updateRes.error) {
      counters.errors.push(`state update: ${updateRes.error.message}`)
    }

    after(async () => {
      try {
        await supabaseAdmin.rpc("flowty_scanner_increment", {
          p_txs_scanned: counters.txsScanned,
          p_failures: counters.txsFailedFlowty,
        })
      } catch {
        // RPC missing or failed — non-fatal; per-run snapshot still saved
      }
    })

    return NextResponse.json({
      ok: true,
      sealedHeight,
      startHeight,
      endHeight,
      ...counters,
      elapsed_ms: elapsed,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...counters,
        elapsed_ms: Date.now() - t0,
      },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
