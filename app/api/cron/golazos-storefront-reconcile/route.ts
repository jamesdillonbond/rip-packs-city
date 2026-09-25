// app/api/cron/golazos-storefront-reconcile/route.ts
//
// Walks every known LaLiga Golazos seller's Dapper NFTStorefrontV2 and
// reconciles `cached_listings_v2` against what is actually listed: adds the
// listings the event indexer never saw, resolves editions it could not, and
// closes ghosts and listings that are gone. Planning rules and the measured
// reason this exists: lib/golazos/storefront-reconcile.ts.
//
// Sellers = every seller_address this table has recorded for Golazos, plus every
// Golazos seller in `sales` over the last 365 days (a seller who listed before
// the indexer started is found through their sales).
//
// Auth: Bearer ${CRON_SECRET} (Vercel cron) or ${INGEST_SECRET_TOKEN} (manual).
// Schedule: vercel.json, every 2 hours.

export const maxDuration = 300
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { normalizeAddress } from "@/lib/address"
import {
  GOLAZOS_COLLECTION_ID,
  GOLAZOS_STOREFRONT_SCRIPT,
  parseStorefrontListings,
  planReconcile,
  type ListingRow,
  type StorefrontListing,
} from "@/lib/golazos/storefront-reconcile"

const PIPELINE_NAME = "golazos-storefront-reconcile"
const COLLECTION_SLUG = "laliga_golazos"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 20_000
// Stop starting new walks here so the writes and the terminal log land well
// inside maxDuration. Measured 2026-09-25: 48 sellers walked in ~40 s.
const WALK_BUDGET_MS = 200_000
const PAGE = 1000

// bigint ids are selected as TEXT: PostgREST returns a bigint as a JSON number,
// and the planner matches them against the storefront's string ids.
const LISTING_COLUMNS =
  "listing_resource_id::text, source, flow_id::text, edition_id, collection_id, seller_address, price_usd, currency, custom_id, listed_at, expiry_at, completed_at, completed_status, block_height, tx_hash, event_index, verified_at"

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const cron = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (!!cron && auth === `Bearer ${cron}`) || (!!ingest && auth === `Bearer ${ingest}`)
}

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type === undefined || value === undefined) return node
  if (type === "Optional") return value === null ? null : unwrapCdc(value)
  if (type === "Array") return (value as unknown[]).map(unwrapCdc)
  if (type === "Dictionary") {
    const out: Record<string, unknown> = {}
    for (const kv of value as Array<{ key: unknown; value: unknown }>) {
      out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
    }
    return out
  }
  return value
}

async function walkSeller(seller: string): Promise<StorefrontListing[]> {
  const args = [{ type: "Address", value: seller }]
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: Buffer.from(GOLAZOS_STOREFRONT_SCRIPT).toString("base64"),
      arguments: args.map((a) => Buffer.from(JSON.stringify(a)).toString("base64")),
    }),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`script HTTP ${res.status}: ${text.slice(0, 160)}`)
  const decoded = JSON.parse(Buffer.from(JSON.parse(text), "base64").toString("utf8"))
  return parseStorefrontListings(unwrapCdc(decoded))
}

// Paged read with a deterministic order on the primary key, so no row is
// skipped or repeated between pages. Throws on error: a partial list is not a
// complete one.
async function readAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label} read failed: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

async function run(startMs: number, startedAt: string) {
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: startMs })

  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  const extra: Record<string, unknown> = {}
  const db = supabaseAdmin as any

  try {
    // 1. Sellers.
    const listingSellers = await readAll<{ seller_address: string }>(
      (f, t) =>
        db
          .from("cached_listings_v2")
          .select("seller_address")
          .eq("collection_id", GOLAZOS_COLLECTION_ID)
          .order("listing_resource_id", { ascending: true })
          .order("source", { ascending: true })
          .range(f, t),
      "listing sellers",
    )
    const saleSellers = await readAll<{ seller_address: string | null }>(
      (f, t) =>
        db
          .from("sales")
          .select("seller_address")
          .eq("collection_id", GOLAZOS_COLLECTION_ID)
          .gte("sold_at", new Date(Date.now() - 365 * 86_400_000).toISOString())
          .not("seller_address", "is", null)
          .order("id", { ascending: true })
          .range(f, t),
      "sale sellers",
    )
    const sellers = [
      ...new Set(
        [...listingSellers, ...saleSellers]
          .map((r) => r.seller_address)
          .filter((a): a is string => typeof a === "string" && a.length > 0)
          .map(normalizeAddress),
      ),
    ].sort()
    extra.sellers_known = sellers.length

    // 2. Walk storefronts. A failed walk is recorded and that seller is left
    // untouched — never read as "the seller has no listings".
    const walked = new Map<string, StorefrontListing[]>()
    const walkErrors: string[] = []
    let unwalked = 0
    for (const seller of sellers) {
      if (Date.now() - startMs > WALK_BUDGET_MS) {
        unwalked++
        continue
      }
      try {
        walked.set(seller, await walkSeller(seller))
      } catch (e) {
        walkErrors.push(`${seller}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const onChain = [...walked.values()].flat()
    rowsFound = onChain.length
    extra.sellers_walked = walked.size
    extra.sellers_walk_errors = walkErrors.length
    extra.walk_error_sample = walkErrors.slice(0, 5)
    extra.sellers_unwalked_budget = unwalked
    extra.onchain_listings = onChain.length

    // 3. Existing rows for the walked sellers, and the edition map.
    const walkedList = [...walked.keys()]
    const existing: ListingRow[] = []
    for (let i = 0; i < walkedList.length; i += 100) {
      const batch = walkedList.slice(i, i + 100)
      existing.push(
        ...(await readAll<ListingRow>(
          (f, t) =>
            db
              .from("cached_listings_v2")
              .select(LISTING_COLUMNS)
              .eq("collection_id", GOLAZOS_COLLECTION_ID)
              .in("seller_address", batch)
              .order("listing_resource_id", { ascending: true })
              .order("source", { ascending: true })
              .range(f, t),
          "existing listings",
        )),
      )
    }
    const editionIds = [...new Set(onChain.map((l) => l.editionExternalId).filter((x): x is string => !!x))]
    const editionUuidByExternalId = new Map<string, string>()
    for (let i = 0; i < editionIds.length; i += 500) {
      const { data, error } = await db
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", GOLAZOS_COLLECTION_ID)
        .in("external_id", editionIds.slice(i, i + 500))
      if (error) throw new Error(`editions read failed: ${error.message}`)
      for (const r of data ?? []) editionUuidByExternalId.set(String(r.external_id), r.id)
    }

    const plan = planReconcile({
      walkedSellers: walked,
      existing,
      editionUuidByExternalId,
      nowEpoch: Math.floor(Date.now() / 1000),
    })
    Object.assign(extra, plan.counts)

    // 4. Writes first, then closes (the sets are disjoint by construction).
    let upsertErrors = 0
    let firstUpsertError: string | null = null
    for (let i = 0; i < plan.upserts.length; i += 200) {
      const batch = plan.upserts.slice(i, i + 200)
      const { error } = await db
        .from("cached_listings_v2")
        .upsert(batch, { onConflict: "listing_resource_id,source", ignoreDuplicates: false })
      if (error) {
        upsertErrors += batch.length
        firstUpsertError ??= error.message
      } else {
        rowsWritten += batch.length
      }
    }
    extra.upsert_errors = upsertErrors
    extra.upsert_error = firstUpsertError

    let closed = 0
    let closeErrors = 0
    let firstCloseError: string | null = null
    const nowIso = new Date().toISOString()
    const groups = new Map<string, string[]>()
    for (const c of plan.closes) {
      const key = `${c.source}|${c.status}`
      groups.set(key, [...(groups.get(key) ?? []), c.listing_resource_id])
    }
    for (const [key, ids] of groups) {
      const [source, status] = key.split("|")
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db
          .from("cached_listings_v2")
          .update({ completed_at: nowIso, completed_status: status })
          .eq("source", source)
          .in("listing_resource_id", ids.slice(i, i + 200))
          .is("completed_at", null)
          .select("listing_resource_id")
        if (error) {
          closeErrors += Math.min(200, ids.length - i)
          firstCloseError ??= error.message
        } else {
          closed += (data ?? []).length
        }
      }
    }
    rowsWritten += closed
    extra.closed = closed
    extra.close_errors = closeErrors
    extra.close_error = firstCloseError

    // ok means the run observed every seller and every write landed.
    const problems: string[] = []
    if (walkErrors.length > 0) problems.push(`${walkErrors.length} storefront walk(s) failed`)
    if (unwalked > 0) problems.push(`${unwalked} seller(s) not walked (time budget)`)
    if (upsertErrors > 0) problems.push(`${upsertErrors} upsert(s) failed: ${firstUpsertError}`)
    if (closeErrors > 0) problems.push(`${closeErrors} close(s) failed: ${firstCloseError}`)
    if (problems.length > 0) {
      ok = false
      errorMsg = problems.join("; ")
    }
  } catch (e) {
    ok = false
    errorMsg = e instanceof Error ? e.message : String(e)
  }

  extra.elapsed_ms = Date.now() - startMs
  const { error: logError } = await db.rpc("log_pipeline_run", {
    p_pipeline: PIPELINE_NAME,
    p_started_at: startedAt,
    p_rows_found: rowsFound,
    p_rows_written: rowsWritten,
    p_rows_skipped: 0,
    p_ok: ok,
    p_error: errorMsg,
    p_collection_slug: COLLECTION_SLUG,
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: extra,
  })
  if (logError) console.error(`[${PIPELINE_NAME}] log_pipeline_run error: ${logError.message}`)
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const startMs = Date.now()
  const startedAt = new Date(startMs).toISOString()
  after(() => run(startMs, startedAt))
  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}
