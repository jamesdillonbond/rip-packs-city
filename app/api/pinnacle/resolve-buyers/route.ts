// app/api/pinnacle/resolve-buyers/route.ts
//
// Pinnacle buyer/seller resolver. The DB primitives
// (claim_pinnacle_resolver_batch, finish_pinnacle_resolver_item, plus the
// pinnacle_resolver_status view) are end-to-end tested; this route is the
// missing executor. Cron-job.org hits it every 5 minutes; with batch=50 the
// ~5,080-row backlog clears in ~9h and stays ahead of the ~17/hour growth
// rate. Auth: Bearer OR ?token= against INGEST_SECRET_TOKEN OR CRON_SECRET
// — same surface as the rest of the pipeline routes.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const FLOW_TX_URL = "https://rest-mainnet.onflow.org/v1/transactions"
const BATCH_LIMIT = 50
const CONCURRENCY = 10
const FETCH_TIMEOUT_MS = 5_000
const PIPELINE_NAME = "pinnacle-resolve-buyers"
const FUNCTION_VERSION = 1

const BUYER_RE = /buyerAddress\s*:\s*Address\s*=\s*(0x[0-9a-fA-F]+)/
const SELLER_RE = /sellerAddress\s*:\s*Address\s*=\s*(0x[0-9a-fA-F]+)/

interface ClaimedRow {
  id: string
  tx_hash: string
  sold_at: string
  attempts: number
}

type Outcome =
  | { kind: "resolved"; id: string; buyer: string; seller: string }
  | { kind: "pre_spork"; id: string }
  | { kind: "fetch_error"; id: string; reason: string }
  | { kind: "regex_miss"; id: string }

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization") ?? ""
  const bearer = authHeader.replace(/^Bearer\s+/i, "")
  const queryToken = req.nextUrl.searchParams.get("token") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN ?? ""
  const cron = process.env.CRON_SECRET ?? ""
  const candidates = [bearer, queryToken].filter(Boolean)
  if (!candidates.length) return false
  return candidates.some((tok) => (ingest && tok === ingest) || (cron && tok === cron))
}

async function processOne(row: ClaimedRow): Promise<Outcome> {
  let res: Response
  try {
    res = await fetch(`${FLOW_TX_URL}/${row.tx_hash}`, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: "fetch_error", id: row.id, reason: err instanceof Error ? err.message : String(err) }
  }

  if (res.status === 404) {
    return { kind: "pre_spork", id: row.id }
  }
  if (!res.ok) {
    return { kind: "fetch_error", id: row.id, reason: `HTTP ${res.status}` }
  }

  let body: { script?: string }
  try {
    body = (await res.json()) as { script?: string }
  } catch (err) {
    return { kind: "fetch_error", id: row.id, reason: `json_parse: ${err instanceof Error ? err.message : String(err)}` }
  }

  const scriptB64 = body?.script
  if (!scriptB64 || typeof scriptB64 !== "string") {
    return { kind: "fetch_error", id: row.id, reason: "no_script_field" }
  }

  // Use Buffer.from(...).toString('utf8') so multi-byte UTF-8 in the Cadence
  // script (string literals, comments) decodes correctly. atob() returns
  // latin1 and corrupts anything above U+00FF.
  const script = Buffer.from(scriptB64, "base64").toString("utf8")
  const buyerMatch = script.match(BUYER_RE)
  const sellerMatch = script.match(SELLER_RE)
  if (!buyerMatch || !sellerMatch) {
    return { kind: "regex_miss", id: row.id }
  }
  return { kind: "resolved", id: row.id, buyer: buyerMatch[1].toLowerCase(), seller: sellerMatch[1].toLowerCase() }
}

async function runInChunks<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const settled = await Promise.allSettled(chunk.map(worker))
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]
      if (s.status === "fulfilled") {
        out.push(s.value)
      } else {
        // Promise.allSettled never throws; this branch is just to satisfy the
        // type system if a worker itself rejects without being caught.
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason)
        out.push({ kind: "fetch_error", id: (chunk[j] as unknown as ClaimedRow).id, reason } as unknown as R)
      }
    }
  }
  return out
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedMs = Date.now()
  const startedAtIso = new Date(startedMs).toISOString()

  // deno-lint-ignore no-explicit-any
  const { data: claimed, error: claimErr } = await (supabaseAdmin as any).rpc(
    "claim_pinnacle_resolver_batch",
    { p_limit: BATCH_LIMIT }
  )
  if (claimErr) {
    return NextResponse.json(
      { status: "error", reason: "claim_failed", error: claimErr.message },
      { status: 500 }
    )
  }
  const rows = (claimed ?? []) as ClaimedRow[]
  if (rows.length === 0) {
    return NextResponse.json({ status: "no_work", elapsed_ms: Date.now() - startedMs })
  }

  const outcomes = await runInChunks(rows, CONCURRENCY, processOne)

  let resolved = 0
  let preSpork = 0
  let fetchErrors = 0
  let regexMisses = 0

  for (const o of outcomes) {
    if (o.kind === "resolved") {
      // deno-lint-ignore no-explicit-any
      const { error } = await (supabaseAdmin as any).rpc("finish_pinnacle_resolver_item", {
        p_id: o.id,
        p_buyer: o.buyer,
        p_seller: o.seller,
        p_resolution_status: "resolved",
      })
      if (error) {
        fetchErrors++
        console.log(`[${PIPELINE_NAME}] finish resolved failed id=${o.id}: ${error.message}`)
      } else {
        resolved++
      }
    } else if (o.kind === "pre_spork") {
      // deno-lint-ignore no-explicit-any
      const { error } = await (supabaseAdmin as any).rpc("finish_pinnacle_resolver_item", {
        p_id: o.id,
        p_buyer: null,
        p_seller: null,
        p_resolution_status: "pre_spork",
      })
      if (error) {
        fetchErrors++
        console.log(`[${PIPELINE_NAME}] finish pre_spork failed id=${o.id}: ${error.message}`)
      } else {
        preSpork++
      }
    } else if (o.kind === "regex_miss") {
      regexMisses++
    } else {
      fetchErrors++
    }
  }

  const elapsedMs = Date.now() - startedMs

  try {
    // deno-lint-ignore no-explicit-any
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rows.length,
      p_rows_written: resolved + preSpork,
      p_rows_skipped: fetchErrors + regexMisses,
      p_ok: true,
      p_error: null,
      p_collection_slug: "disney_pinnacle",
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        total_claimed: rows.length,
        resolved,
        pre_spork: preSpork,
        fetch_errors: fetchErrors,
        regex_misses: regexMisses,
        elapsed_ms: elapsedMs,
        function_version: FUNCTION_VERSION,
      },
    })
  } catch (err) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run threw: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return NextResponse.json({
    status: "ok",
    resolved,
    pre_spork: preSpork,
    errors: fetchErrors + regexMisses,
    total_claimed: rows.length,
    elapsed_ms: elapsedMs,
  })
}
