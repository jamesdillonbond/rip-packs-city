// app/api/cron/golazos-storefront-reconcile/route.ts
//
// Walks every known seller's Dapper NFTStorefrontV2 for one collection and
// reconciles `cached_listings_v2` against what is actually listed: adds the
// listings the event indexer never saw, resolves editions it could not, and
// closes ghosts and listings that are gone. Planning rules, the per-collection
// config and the measured reason this exists: lib/golazos/storefront-reconcile.ts.
//
//   ?collection=laliga_golazos (default) | nfl_all_day
//
// The path keeps its Golazos name because vercel.json, the pipeline history and
// the ledger all cite it; All Day runs through it with ?collection=nfl_all_day
// and logs under its own pipeline name (allday-storefront-reconcile).
//
// Sellers come from storefront_reconcile_sellers() in ONE call (listing sellers on
// Dapper storefronts + recent sale sellers), walked a few at a time.
//
// Auth: Bearer ${CRON_SECRET} (Vercel cron) or ${INGEST_SECRET_TOKEN} (manual).
// Schedule: vercel.json, every 2 hours per collection.

export const maxDuration = 300
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { normalizeAddress } from "@/lib/address"
import {
  STOREFRONT_COLLECTIONS,
  parseStorefrontListings,
  planReconcile,
  storefrontScriptFor,
  type ListingRow,
  type StorefrontCollection,
  type StorefrontListing,
} from "@/lib/golazos/storefront-reconcile"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const SCRIPT_TIMEOUT_MS = 20_000
// Stop starting new walks here so the writes and the terminal log land well inside
// maxDuration. Measured 2026-09-25: Golazos' 170 sellers walked in ~18 s serially.
const WALK_BUDGET_MS = 200_000
const WALK_CONCURRENCY = 6
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

async function walkSeller(script: string, seller: string): Promise<StorefrontListing[]> {
  const args = [{ type: "Address", value: seller }]
  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      script: Buffer.from(script).toString("base64"),
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

async function run(cfg: StorefrontCollection, startMs: number, startedAt: string) {
  await writeInvocationHeartbeat({ pipeline: cfg.pipeline, startedAtMs: startMs })

  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  const extra: Record<string, unknown> = { collection: cfg.slug }
  const db = supabaseAdmin as any

  try {
    // 1. Sellers, in one call.
    const { data: sellerData, error: sellerErr } = await db.rpc("storefront_reconcile_sellers", {
      p_collection_id: cfg.collectionId,
      p_sale_days: cfg.saleSellerDays,
    })
    if (sellerErr) throw new Error(`sellers read failed: ${sellerErr.message}`)
    if (!Array.isArray(sellerData)) throw new Error("sellers read returned a non-array")
    const sellers = [
      ...new Set((sellerData as unknown[]).filter((a): a is string => typeof a === "string").map(normalizeAddress)),
    ].sort()
    extra.sellers_known = sellers.length

    // 2. Walk storefronts, a few at a time. A failed walk is recorded and that
    // seller is left untouched — never read as "the seller has no listings".
    const script = storefrontScriptFor(cfg)
    const walked = new Map<string, StorefrontListing[]>()
    const walkErrors: string[] = []
    let unwalked = 0
    let next = 0
    async function worker() {
      while (next < sellers.length) {
        const seller = sellers[next++]
        if (Date.now() - startMs > WALK_BUDGET_MS) {
          unwalked++
          continue
        }
        try {
          walked.set(seller, await walkSeller(script, seller))
        } catch (e) {
          walkErrors.push(`${seller}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(WALK_CONCURRENCY, sellers.length) }, worker))
    const onChain = [...walked.values()].flat()
    rowsFound = onChain.length
    extra.sellers_walked = walked.size
    extra.sellers_walk_errors = walkErrors.length
    extra.walk_error_sample = walkErrors.slice(0, 5)
    extra.sellers_unwalked_budget = unwalked
    extra.onchain_listings = onChain.length

    // 3. Existing rows for the walked sellers (only the sources this storefront
    // backs), and the edition map.
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
              .eq("collection_id", cfg.collectionId)
              .in("seller_address", batch)
              .in("source", ["direct_v2", "storefront_v2"])
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
        .eq("collection_id", cfg.collectionId)
        .in("external_id", editionIds.slice(i, i + 500))
      if (error) throw new Error(`editions read failed: ${error.message}`)
      for (const r of data ?? []) editionUuidByExternalId.set(String(r.external_id), r.id)
    }

    const plan = planReconcile({
      walkedSellers: walked,
      existing,
      editionUuidByExternalId,
      nowEpoch: Math.floor(Date.now() / 1000),
      collectionId: cfg.collectionId,
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
    p_pipeline: cfg.pipeline,
    p_started_at: startedAt,
    p_rows_found: rowsFound,
    p_rows_written: rowsWritten,
    p_rows_skipped: 0,
    p_ok: ok,
    p_error: errorMsg,
    p_collection_slug: cfg.slug,
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: extra,
  })
  if (logError) console.error(`[${cfg.pipeline}] log_pipeline_run error: ${logError.message}`)
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const slug = req.nextUrl.searchParams.get("collection") ?? "laliga_golazos"
  const cfg = STOREFRONT_COLLECTIONS[slug]
  // An unknown collection is refused, never defaulted to another collection's walk.
  if (!cfg) return NextResponse.json({ error: `unknown collection: ${slug}` }, { status: 400 })
  const startMs = Date.now()
  const startedAt = new Date(startMs).toISOString()
  after(() => run(cfg, startMs, startedAt))
  return NextResponse.json({ ok: true, accepted: true, pipeline: cfg.pipeline }, { status: 202 })
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}
