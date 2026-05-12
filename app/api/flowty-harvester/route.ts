import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── Flowty API harvester (pre-shutdown data preservation) ───────────────────
//
// Aggressively pulls every Flowty API endpoint we know about (and a handful of
// speculative ones) and archives the raw payload verbatim to
// flowty_archive.api_harvest_20260512. No transformation — we mine the archive
// in SQL later. The goal is to preserve LiveToken FMV estimates, aggregated
// edition stats, fee/royalty info, bid/offer books, and lender offers before
// Flowty potentially shutters their API.
//
// Auth: Authorization: Bearer ${INGEST_SECRET_TOKEN}  (POST or GET)
// State: flowty_archive.harvest_state(id='harvester', cursor jsonb)
//
// Each invocation runs a bounded amount of work (~50s wall clock) and persists
// cursor state so the cron can resume on the next tick. Returns a summary +
// `more_work` boolean — cron should keep calling until it's false.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 90

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const FLOWTY_PROXY_URL =
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://bxcqstmqfzmuolpuynti.supabase.co") +
  "/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN ?? ""

const FIRESTORE_BASE =
  "https://firestore.googleapis.com/v1/projects/flowty-prod/databases/(default)"

const TIME_BUDGET_MS = 50_000
const THROTTLE_MS = 250
const BATCH_FLUSH_SIZE = 20
const PIPELINE_NAME = "flowty-harvester"
const CURSOR_ID = "harvester"

const FIRESTORE_PAGE_SIZE = 200
const COLLECTION_PAGE_SIZE = 100
const NFT_DETAIL_BATCH = 5

interface Collection {
  slug: string
  addr: string
  name: string
  collectionId: string
}

// The five contracts we care about. addr is lower-cased on-chain form. name
// is the contract name as it appears in Flowty's REST path.
const COLLECTIONS: Collection[] = [
  { slug: "topshot",  addr: "0x0b2a3299cc857e29", name: "TopShot",  collectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd" },
  { slug: "allday",   addr: "0xe4cf4bdc1751c65d", name: "AllDay",   collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070" },
  { slug: "golazos",  addr: "0x87ca73a41bb50ad5", name: "Golazos",  collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75" },
  { slug: "ufc",      addr: "0x329feb3ab062d289", name: "UFC_NFT",  collectionId: "9b4824a8-736d-4a96-b450-8dcc0c46b023" },
  { slug: "pinnacle", addr: "0xedf9df96c92f4595", name: "Pinnacle", collectionId: "7dd9dd11-e8b6-45c4-ac99-71331f959714" },
]

// Firestore event types we already know exist. The harvester paginates each
// one backwards in time via blockTimestamp LESS_THAN cursor until Flowty
// stops returning rows, so we capture as much history as their Firestore
// retention will hand over.
const FIRESTORE_EVENT_TYPES = [
  "STOREFRONT_PURCHASED",
  "STOREFRONT_LISTING_CREATED",
  "STOREFRONT_LISTING_CANCELLED",
  "STOREFRONT_OFFER_CREATED",
  "STOREFRONT_OFFER_CANCELLED",
  // Speculative — if they don't exist, Firestore returns 0 docs and we mark exhausted.
  "STOREFRONT_LISTING_COMPLETED",
  "LOAN_CREATED",
  "LOAN_REPAID",
  "LOAN_LIQUIDATED",
  "LOAN_FUNDED",
  "FUNDING_AVAILABLE",
  "FUNDING_REPAID",
  "FUNDING_SETTLED",
  "FUNDING_CANCELLED",
  "BID_CREATED",
  "BID_CANCELLED",
]

// One-shot probes against speculative paths. Each is hit once per cursor
// reset — the response (even 404) is archived so we can audit which endpoints
// actually exist without re-poking them every cron tick.
function buildProbes(): Array<{ key: string; url: string; method: "GET" | "POST"; body?: unknown; hint?: string }> {
  const out: Array<{ key: string; url: string; method: "GET" | "POST"; body?: unknown; hint?: string }> = []
  for (const c of COLLECTIONS) {
    const base = `https://api2.flowty.io/collection/${c.addr}/${c.name}`
    out.push({ key: `stats:${c.slug}`,        url: `${base}/stats`,        method: "GET", hint: c.slug })
    out.push({ key: `analytics:${c.slug}`,    url: `${base}/analytics`,    method: "GET", hint: c.slug })
    out.push({ key: `traits:${c.slug}`,       url: `${base}/traits`,       method: "GET", hint: c.slug })
    out.push({ key: `metadata:${c.slug}`,     url: `${base}/metadata`,     method: "GET", hint: c.slug })
    out.push({ key: `royalty:${c.slug}`,      url: `${base}/royalty`,      method: "GET", hint: c.slug })
    out.push({ key: `info:${c.slug}`,         url: `${base}/info`,         method: "GET", hint: c.slug })
    out.push({ key: `sales-feed:${c.slug}`,   url: `https://api2.flowty.io/sales/${c.addr}/${c.name}`, method: "GET", hint: c.slug })
    out.push({ key: `bids-feed:${c.slug}`,    url: `https://api2.flowty.io/bids/${c.addr}/${c.name}`, method: "GET", hint: c.slug })
    out.push({ key: `loans-feed:${c.slug}`,   url: `https://api2.flowty.io/loans/${c.addr}/${c.name}`, method: "GET", hint: c.slug })
  }
  // Cross-collection / global endpoints.
  out.push({ key: "marketplace:featured", url: "https://api2.flowty.io/marketplace/featured", method: "GET" })
  out.push({ key: "marketplace:trending", url: "https://api2.flowty.io/marketplace/trending", method: "GET" })
  out.push({ key: "marketplace:fees",     url: "https://api2.flowty.io/marketplace/fees",     method: "GET" })
  out.push({ key: "lending:offers",       url: "https://api2.flowty.io/lending/offers",       method: "GET" })
  out.push({ key: "lending:rates",        url: "https://api2.flowty.io/lending/rates",        method: "GET" })
  return out
}

interface ArchiveRow {
  endpoint: string
  query_params: unknown
  response_payload: unknown
  response_status: number | null
  collection_hint: string | null
}

interface CollectionState {
  offset: number
  exhausted: boolean
}

interface FirestoreState {
  before: string | null
  exhausted: boolean
}

interface HarvestCursor {
  firestore?: Record<string, FirestoreState>
  collections_sale?: Record<string, CollectionState>
  collections_loan?: Record<string, CollectionState>
  nft_details_done?: Record<string, boolean>
  probes_done?: Record<string, boolean>
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchFirestorePage(
  type: string,
  beforeTs: string | null,
): Promise<{ status: number; body: unknown }> {
  const filters: object[] = [
    {
      fieldFilter: {
        field: { fieldPath: "type" },
        op: "EQUAL",
        value: { stringValue: type },
      },
    },
  ]
  if (beforeTs) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "blockTimestamp" },
        op: "LESS_THAN",
        value: { timestampValue: beforeTs },
      },
    })
  }
  const body = {
    structuredQuery: {
      from: [{ collectionId: "events" }],
      where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } },
      orderBy: [{ field: { fieldPath: "blockTimestamp" }, direction: "DESCENDING" }],
      limit: FIRESTORE_PAGE_SIZE,
    },
  }
  try {
    const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } }
  }
}

// Pulls oldest blockTimestamp out of a Firestore runQuery response so we can
// step the cursor backwards on the next page. Returns null if the page is
// empty (caller treats as exhausted).
function oldestTimestampFromFirestore(body: unknown): string | null {
  if (!Array.isArray(body)) return null
  for (let i = body.length - 1; i >= 0; i--) {
    const r = (body as Array<{ document?: { fields?: { blockTimestamp?: { timestampValue?: string } } } }>)[i]
    const ts = r?.document?.fields?.blockTimestamp?.timestampValue
    if (ts) return ts
  }
  return null
}

function firestoreDocCount(body: unknown): number {
  if (!Array.isArray(body)) return 0
  return (body as Array<{ document?: unknown }>).filter((r) => r.document).length
}

async function fetchCollectionPage(
  c: Collection,
  offset: number,
  kind: "sale" | "loan",
): Promise<{ status: number; body: unknown }> {
  const payload =
    kind === "loan"
      ? {
          filters: {},
          offset,
          limit: COLLECTION_PAGE_SIZE,
          orderFilters: [{ conditions: [], kind: "loan", paymentTokens: [] }],
          sort: { direction: "desc", listingKind: "loan", path: "blockTimestamp" },
        }
      : { filters: {}, offset, limit: COLLECTION_PAGE_SIZE }
  try {
    const res = await fetch(FLOWTY_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
      },
      body: JSON.stringify({ contractAddress: c.addr, contractName: c.name, payload }),
      signal: AbortSignal.timeout(15_000),
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } }
  }
}

function collectionItemCount(body: unknown): number {
  if (!body || typeof body !== "object") return 0
  const o = body as { nfts?: unknown[]; data?: unknown[] }
  const items = o.nfts ?? o.data ?? []
  return Array.isArray(items) ? items.length : 0
}

async function fetchNftDetail(
  c: Collection,
  nftId: string,
): Promise<{ status: number; body: unknown }> {
  const url = `https://api2.flowty.io/nft/${c.addr}/${c.name}/${encodeURIComponent(nftId)}`
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Origin: "https://www.flowty.io",
        "User-Agent": "rip-packs-city/flowty-harvester",
      },
      signal: AbortSignal.timeout(10_000),
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { status: res.status, body: parsed }
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } }
  }
}

async function fetchProbe(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Origin: "https://www.flowty.io",
        "User-Agent": "rip-packs-city/flowty-harvester",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      try {
        parsed = await res.text()
      } catch {
        parsed = null
      }
    }
    return { status: res.status, body: parsed }
  } catch (err) {
    return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } }
  }
}

// ── Cursor I/O ──────────────────────────────────────────────────────────────

async function loadCursor(): Promise<HarvestCursor> {
  const { data, error } = await (supabaseAdmin as any).rpc("flowty_archive_get_cursor", { p_id: CURSOR_ID })
  if (error) {
    console.log(`[flowty-harvester] cursor read err: ${error.message}`)
    return {}
  }
  return (data ?? {}) as HarvestCursor
}

async function saveCursor(cursor: HarvestCursor): Promise<void> {
  const { error } = await (supabaseAdmin as any).rpc("flowty_archive_set_cursor", {
    p_id: CURSOR_ID,
    p_cursor: cursor,
  })
  if (error) console.log(`[flowty-harvester] cursor write err: ${error.message}`)
}

// ── Sample per-collection NFT IDs from wmc for the /nft/{id} probes ─────────

async function sampleNftIdsForCollection(
  collectionId: string,
  excludeAlreadyDone: Set<string>,
  limit: number,
): Promise<string[]> {
  const { data } = await (supabaseAdmin as any)
    .from("wallet_moments_cache")
    .select("moment_id")
    .eq("collection_id", collectionId)
    .order("last_seen_at", { ascending: false })
    .limit(limit * 4)
  const rows = (data ?? []) as Array<{ moment_id: string }>
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    if (!r.moment_id) continue
    if (seen.has(r.moment_id)) continue
    if (excludeAlreadyDone.has(`${collectionId}:${r.moment_id}`)) continue
    seen.add(r.moment_id)
    out.push(String(r.moment_id))
    if (out.length >= limit) break
  }
  return out
}

// ── Main handler ────────────────────────────────────────────────────────────

async function handle(req: NextRequest) {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()
  if (!FLOWTY_PROXY_TOKEN) {
    return NextResponse.json({ error: "FLOWTY_PROXY_TOKEN missing" }, { status: 500 })
  }

  const reset = req.nextUrl.searchParams.get("reset") === "1"
  const start = Date.now()
  const startedAt = new Date(start).toISOString()
  const deadline = start + TIME_BUDGET_MS
  const withinBudget = () => Date.now() < deadline

  let cursor: HarvestCursor = reset ? {} : await loadCursor()
  if (!cursor.firestore) cursor.firestore = {}
  if (!cursor.collections_sale) cursor.collections_sale = {}
  if (!cursor.collections_loan) cursor.collections_loan = {}
  if (!cursor.nft_details_done) cursor.nft_details_done = {}
  if (!cursor.probes_done) cursor.probes_done = {}

  const buffer: ArchiveRow[] = []
  let totalWritten = 0
  let totalCalls = 0
  let totalBytes = 0
  let throttleHits = 0
  const errors: Array<{ where: string; msg: string }> = []
  const phases: Record<string, number> = {}

  const flush = async () => {
    if (buffer.length === 0) return
    const batch = buffer.splice(0, buffer.length)
    const { data, error } = await (supabaseAdmin as any).rpc("flowty_archive_insert_batch", { p_rows: batch })
    if (error) {
      errors.push({ where: "archive_insert", msg: error.message })
      console.log(`[flowty-harvester] insert err: ${error.message}`)
    } else {
      totalWritten += typeof data === "number" ? data : batch.length
    }
  }

  const archive = async (row: ArchiveRow) => {
    totalCalls++
    try {
      const serialized = JSON.stringify(row.response_payload ?? null)
      totalBytes += serialized.length
    } catch {
      // payload may have circular refs from a broken response — skip the size measure
    }
    buffer.push(row)
    if (buffer.length >= BATCH_FLUSH_SIZE) await flush()
  }

  // Phase 1 — Firestore events. Paginate each event type backwards in time
  // via blockTimestamp LESS_THAN cursor until we hit a short page (exhausted).
  for (const type of FIRESTORE_EVENT_TYPES) {
    if (!withinBudget()) break
    const state = cursor.firestore![type] ?? { before: null, exhausted: false }
    if (state.exhausted) continue
    let before = state.before
    while (withinBudget()) {
      const { status, body } = await fetchFirestorePage(type, before)
      await archive({
        endpoint: `firestore:${type}`,
        query_params: { beforeTs: before, limit: FIRESTORE_PAGE_SIZE },
        response_payload: body,
        response_status: status,
        collection_hint: null,
      })
      phases[`firestore:${type}`] = (phases[`firestore:${type}`] ?? 0) + 1
      const docCount = firestoreDocCount(body)
      if (docCount === 0) {
        state.exhausted = true
        break
      }
      const oldest = oldestTimestampFromFirestore(body)
      if (!oldest || oldest === before) {
        state.exhausted = true
        break
      }
      before = oldest
      if (docCount < FIRESTORE_PAGE_SIZE) {
        state.exhausted = true
        break
      }
      throttleHits++
      await delay(THROTTLE_MS)
    }
    state.before = before
    cursor.firestore![type] = state
  }

  // Phase 2 — Collection sale listings per collection. Paginate offset until
  // a short page comes back. Each page captures the full nfts[] array plus
  // valuations.blended.usdValue (LiveToken FMV) embedded in each entry.
  for (const c of COLLECTIONS) {
    if (!withinBudget()) break
    const state = cursor.collections_sale![c.slug] ?? { offset: 0, exhausted: false }
    if (state.exhausted) continue
    while (withinBudget()) {
      const { status, body } = await fetchCollectionPage(c, state.offset, "sale")
      await archive({
        endpoint: `collection:${c.slug}:sale`,
        query_params: { offset: state.offset, limit: COLLECTION_PAGE_SIZE },
        response_payload: body,
        response_status: status,
        collection_hint: c.slug,
      })
      phases[`collection:${c.slug}:sale`] = (phases[`collection:${c.slug}:sale`] ?? 0) + 1
      const items = collectionItemCount(body)
      if (items === 0) {
        state.exhausted = true
        break
      }
      state.offset += COLLECTION_PAGE_SIZE
      if (items < COLLECTION_PAGE_SIZE) {
        state.exhausted = true
        break
      }
      throttleHits++
      await delay(THROTTLE_MS)
    }
    cursor.collections_sale![c.slug] = state
  }

  // Phase 3 — Loan book per collection. Same endpoint, different payload
  // (`orderFilters[].kind = "loan"`). Captures the lender offer book which
  // is the highest-leverage data NOT reconstructable from chain events alone.
  for (const c of COLLECTIONS) {
    if (!withinBudget()) break
    const state = cursor.collections_loan![c.slug] ?? { offset: 0, exhausted: false }
    if (state.exhausted) continue
    while (withinBudget()) {
      const { status, body } = await fetchCollectionPage(c, state.offset, "loan")
      await archive({
        endpoint: `collection:${c.slug}:loan`,
        query_params: { offset: state.offset, limit: COLLECTION_PAGE_SIZE, kind: "loan" },
        response_payload: body,
        response_status: status,
        collection_hint: c.slug,
      })
      phases[`collection:${c.slug}:loan`] = (phases[`collection:${c.slug}:loan`] ?? 0) + 1
      const items = collectionItemCount(body)
      if (items === 0) {
        state.exhausted = true
        break
      }
      state.offset += COLLECTION_PAGE_SIZE
      if (items < COLLECTION_PAGE_SIZE) {
        state.exhausted = true
        break
      }
      throttleHits++
      await delay(THROTTLE_MS)
    }
    cursor.collections_loan![c.slug] = state
  }

  // Phase 4 — Per-NFT GETs. Direct from Vercel (no proxy worker). These may
  // be IP-blocked from Vercel egress; if so the archive will show 403/451 and
  // the cron can stop sampling. We capture both success and failure so we can
  // tell from SQL whether to invest in adding a route to the proxy worker.
  const alreadyDone = new Set<string>(Object.keys(cursor.nft_details_done!))
  for (const c of COLLECTIONS) {
    if (!withinBudget()) break
    const sample = await sampleNftIdsForCollection(c.collectionId, alreadyDone, NFT_DETAIL_BATCH)
    for (const nftId of sample) {
      if (!withinBudget()) break
      const { status, body } = await fetchNftDetail(c, nftId)
      await archive({
        endpoint: `nft:${c.slug}`,
        query_params: { nft_id: nftId },
        response_payload: body,
        response_status: status,
        collection_hint: c.slug,
      })
      phases[`nft:${c.slug}`] = (phases[`nft:${c.slug}`] ?? 0) + 1
      cursor.nft_details_done![`${c.collectionId}:${nftId}`] = true
      throttleHits++
      await delay(THROTTLE_MS)
    }
  }

  // Phase 5 — One-shot probes against speculative paths. Each probe runs at
  // most once per cursor reset; the response status + body is archived so we
  // can audit endpoint surface in SQL without re-poking.
  const probes = buildProbes()
  for (const p of probes) {
    if (!withinBudget()) break
    if (cursor.probes_done![p.key]) continue
    const { status, body } = await fetchProbe(p.url, p.method, p.body)
    await archive({
      endpoint: `probe:${p.key}`,
      query_params: { url: p.url, method: p.method, body: p.body ?? null },
      response_payload: body,
      response_status: status,
      collection_hint: p.hint ?? null,
    })
    phases[`probe`] = (phases[`probe`] ?? 0) + 1
    cursor.probes_done![p.key] = true
    throttleHits++
    await delay(THROTTLE_MS)
  }

  // Final flush + cursor save.
  await flush()
  await saveCursor(cursor)

  // Did we leave any non-exhausted state? Cron can stop calling when this
  // flips false.
  const moreFirestore = FIRESTORE_EVENT_TYPES.some((t) => !(cursor.firestore![t]?.exhausted))
  const moreCollectionsSale = COLLECTIONS.some((c) => !(cursor.collections_sale![c.slug]?.exhausted))
  const moreCollectionsLoan = COLLECTIONS.some((c) => !(cursor.collections_loan![c.slug]?.exhausted))
  const moreProbes = probes.some((p) => !cursor.probes_done![p.key])
  const moreWork = moreFirestore || moreCollectionsSale || moreCollectionsLoan || moreProbes

  const extra = {
    total_calls: totalCalls,
    total_written: totalWritten,
    total_bytes: totalBytes,
    throttle_hits: throttleHits,
    errors,
    phases,
    elapsed_ms: Date.now() - start,
    more_work: moreWork,
    cursor_summary: {
      firestore_exhausted_count: FIRESTORE_EVENT_TYPES.filter((t) => cursor.firestore![t]?.exhausted).length,
      firestore_total: FIRESTORE_EVENT_TYPES.length,
      sale_exhausted_count: COLLECTIONS.filter((c) => cursor.collections_sale![c.slug]?.exhausted).length,
      loan_exhausted_count: COLLECTIONS.filter((c) => cursor.collections_loan![c.slug]?.exhausted).length,
      nft_details_done_count: Object.keys(cursor.nft_details_done!).length,
      probes_done_count: Object.keys(cursor.probes_done!).length,
      probes_total: probes.length,
    },
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: totalCalls,
      p_rows_written: totalWritten,
      p_rows_skipped: errors.length,
      p_ok: errors.length === 0,
      p_error: errors.length > 0 ? errors.slice(0, 3).map((e) => `${e.where}:${e.msg}`).join("|").slice(0, 500) : null,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: extra,
    })
  } catch (e) {
    console.log(`[flowty-harvester] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }

  return NextResponse.json({
    ok: errors.length === 0,
    ...extra,
  })
}

export async function POST(req: NextRequest) {
  return handle(req)
}

export async function GET(req: NextRequest) {
  return handle(req)
}
