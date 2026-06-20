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
// searchMarketplaceTransactions per target edition and inserts the missing
// historical sales. fmv-recalc's normal sweep then re-labels them off real sales.
//
// KEYING (verified live 2026-06-11): the TS marketplace GQL (byEditions filter on
// searchMarketplaceTransactions / searchEditions) is UUID-keyed — passing the
// on-chain integer setID/playID returns `invalid input syntax for type uuid`.
// Our canonical targets are int-keyed and we only store a real SET uuid
// (sets.external_id). So per target we:
//   1. take the set uuid (seeded from our DB),
//   2. resolve the PLAY uuid by paging searchEditions(bySetIDs:[set_uuid]) and
//      mapping play.flowID(int) -> play.id(uuid) — cached per set per tick, and
//      persisted on the progress row so it's resolved once,
//   3. query searchMarketplaceTransactions(byEditions:[{setID:uuid, playID:uuid}]).
// We create ZERO editions and attribute every sale to the KNOWN target
// edition_id, so the UUID-keyed writer-dupe footgun cannot apply here.
//
// SAFETY RAILS (see handoff):
//  • SYNCHRONOUS, no after()/waitUntil (those tails die silently on Vercel).
//    Because the response is synchronous, the platform's HARD 300s response cap
//    is the limiter — confirmed 2026-06-12: the gateway returns 504 at exactly
//    300s and maxDuration kills the lambda at the same instant, so any run that
//    isn't DONE by ~300s loses its terminal pipeline_runs row (the drained rows
//    still commit — inserts are per-edition + idempotent — but telemetry is lost
//    and GHA can't see success). So the loop self-budgets to ~120s AND each
//    edition is page-capped to ~50-80s, guaranteeing loop+finalize returns with
//    margin under 300s. Each rare GHA fire still drains ~15-25 editions (vs ~1-8).
//  • Self-throttle: >15 pipeline_runs fails in the last 30 min → skip the tick.
//  • Idempotent: dedup by txHash against existing sales + a 23505 row-by-row
//    fallback (the partial unique indexes can't be inferred by onConflict).
//  • Tagged source='ts_history_backfill_v1' → revert is one DELETE.
//
// Kill switch: disable the GHA workflow (one commit) OR set env
//   TS_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300 // bounds runaway; the ~180s work-budget is the real limiter (gateway cuts ~340s)

const PIPELINE_NAME = "topshot-sales-history-backfill"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const SOURCE_TAG = "ts_history_backfill_v1"

// Pacing / safety knobs. The platform caps a synchronous response at a HARD 300s
// (gateway 504 + maxDuration kill coincide — confirmed 2026-06-12: a 180s-budget
// run hit 300s and was killed mid-finalize, no terminal log). The budget is
// checked only BETWEEN editions, so it MUST leave room for one worst-case edition
// + finalize under 300s. Two levers together guarantee a clean return+log:
//   • ELAPSED_BUDGET_MS well under 300s, and
//   • MAX_*_PAGES bounding any single edition to ~50-80s.
// 2026-06-16: throughput dial (handoff item 4 — drain the finite ~287-edition
// tail faster). ELAPSED_BUDGET_MS is the REAL limiter — the loop breaks on it
// long before EDITIONS_PER_TICK bites — so raising the count cap alone does
// nothing; both move together. 180s budget + one worst-case edition (~80s via
// MAX_*_PAGES) + finalize (~5s) ≈ 265s, still clear of the 300s hard cap. These
// are illiquid zero-sale targets, so the per-edition worst case is rare (ingest
// pages return empty fast; only a fresh set-map resolution is costly, and it
// caches per set per tick). EDITIONS_PER_TICK=80 just keeps the count from
// binding before the time budget does.
const EDITIONS_PER_TICK = 120
// 2026-06-19 throughput dial. play_uuid is now PRE-SEEDED onto the queue from
// edition_offers (migration audit_20260619_preseed_ts_history_backfill_play_uuid_from_offers,
// 98% coverage, validated 615/615) AND resolved per-row from edition_offers in
// drainEdition, so the expensive GQL searchEditions set-map walk — the ~120s
// worst-case op that once pushed a 180s-budget run to the 300s gateway kill — is
// now RARE. Two guards make a 300s overrun structurally impossible regardless:
//   • HARD_CAP_MS — every GQL page loop (set-map AND tx-ingest) bails past it, so
//     no single edition can run unbounded, and
//   • the between-edition ELAPSED_BUDGET_MS check.
// With set-map de-risked, the budget can safely rise 180s→240s for ~33% more
// drained editions/run. The other lever is cron cadence (operator) — raising it
// drains the ~8.5K queue proportionally faster.
const ELAPSED_BUDGET_MS = 240_000
// Absolute per-edition wall. Each GQL page loop checks this and bails; the last
// in-flight proxy call (≤~25s) + finalize (~5s) then lands under the 300s gateway
// cap. Leaves ~35s of headroom under maxDuration.
const HARD_CAP_MS = 265_000
const TX_PAGE_LIMIT = 50
const MAX_TX_PAGES = 8 // ≤400 most-recent sales/edition (UPDATED_AT_DESC) — bounds runtime; these are illiquid targets and fmv-recalc uses a recency-weighted WAP
const SET_PAGE_LIMIT = 250
const MAX_SET_PAGES = 8 // ≤2000 plays/set — bounds the fresh-set resolution cost
const INSERT_CHUNK = 400
const SATURATION_FAIL_THRESHOLD = 15
const MAX_EDITION_ATTEMPTS = 4

// ── GraphQL ──────────────────────────────────────────────────────────────────

// Resolve a set's play.flowID(int) -> play.id(uuid) map. searchEditions only
// accepts UUID set ids (bySetIDs), so this is keyed by the set uuid.
const SET_PLAY_MAP_QUERY = `
  query SetPlayMap($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        pagination { rightCursor }
        data {
          ... on Editions {
            data {
              ... on Edition {
                play { id flowID }
              }
            }
          }
        }
      }
    }
  }
`

// Per-edition transactions. byEditions takes UUID set/play ids.
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
  } | null
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Set → play-uuid resolver ─────────────────────────────────────────────────

function parseSetEditions(data: unknown): {
  plays: Array<{ id: string | null; flowID: string | null }>
  nextCursor: string | null
} {
  const summary = (data as any)?.searchEditions?.searchSummary
  const nextCursor = summary?.pagination?.rightCursor ?? null
  const plays: Array<{ id: string | null; flowID: string | null }> = []
  const rows = summary?.data?.data
  if (Array.isArray(rows)) {
    for (const e of rows) {
      if (e?.play) plays.push({ id: e.play.id ?? null, flowID: e.play.flowID ?? null })
    }
  }
  return { plays, nextCursor }
}

// Build flowID(int string) -> play uuid for a whole set. Pages until exhausted
// (capped). Throws on GQL error so the caller can do a bounded retry.
async function resolveSetPlayMap(setUuid: string, deadlineMs: number): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let cursor: string | null = null
  for (let i = 0; i < MAX_SET_PAGES; i++) {
    if (Date.now() > deadlineMs) break // hard wall — never start another page near the 300s cap
    const data = await topshotGraphql<unknown>(SET_PLAY_MAP_QUERY, {
      input: {
        filters: { bySetIDs: [setUuid] },
        searchInput: { pagination: { cursor: cursor ?? "", direction: "RIGHT", limit: SET_PAGE_LIMIT } },
      },
    })
    const { plays, nextCursor } = parseSetEditions(data)
    if (plays.length === 0) break
    for (const p of plays) {
      if (p.flowID != null && p.id) map.set(String(p.flowID), p.id)
    }
    cursor = nextCursor
    if (!cursor) break
  }
  return map
}

// ── Transactions ─────────────────────────────────────────────────────────────

function extractTransactions(data: unknown): { txs: EditionTx[]; nextCursor: string | null } {
  const summary = (data as any)?.searchMarketplaceTransactions?.data?.searchSummary
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

async function fetchTxPage(
  setUuid: string,
  playUuid: string,
  cursor: string | null,
): Promise<{ txs: EditionTx[]; nextCursor: string | null }> {
  const data = await topshotGraphql<unknown>(EDITION_TRANSACTIONS_QUERY, {
    input: {
      sortBy: "UPDATED_AT_DESC",
      filters: { byEditions: [{ setID: setUuid, playID: playUuid }] },
      searchInput: { pagination: { cursor: cursor ?? "", direction: "RIGHT", limit: TX_PAGE_LIMIT } },
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
  playUuid: string | null
  error: string | null
}

// Parallel/subedition redirect (Phase-4 conflation-leak fix, 2026-06-20).
// The marketplace history for a base (setID:playID) edition also returns sales
// of its PARALLEL moments (Hexwave, Jukebox, …) — they share the base play but
// belong to their own `setID:playID::subID` edition. Keying those onto the base
// re-creates dup-serial conflation (the documented Phase-4 teardown blocker).
// So before insert we resolve each sale's nft_id against the fully-populated
// topshot_moment_subeditions map and redirect parallel sales onto their existing
// `::` edition. An nft_id not yet in that map (a parallel not on-chain-resolved)
// falls through to the base and is swept by the periodic historical re-remap —
// the same forward-path `::` logic, mirrored here for the history-backfill writer.
async function redirectParallelSales(editionKey: string, candidates: Map<string, SaleRow>): Promise<void> {
  const nftIds = Array.from(
    new Set(
      Array.from(candidates.values())
        .map((r) => r.nft_id)
        .filter((v): v is string => !!v),
    ),
  )
  if (nftIds.length === 0) return

  // nft_id -> subedition_id (parallels only) from the resolver table.
  const subByNft = new Map<string, number>()
  for (let i = 0; i < nftIds.length; i += 300) {
    const chunk = nftIds.slice(i, i + 300)
    const { data } = await supabaseAdmin
      .from("topshot_moment_subeditions")
      .select("nft_id, subedition_id")
      .in("nft_id", chunk)
      .gt("subedition_id", 0)
    for (const r of (data ?? []) as Array<{ nft_id: string; subedition_id: number }>) {
      subByNft.set(String(r.nft_id), r.subedition_id)
    }
  }
  if (subByNft.size === 0) return // all Standard — nothing to redirect

  // subedition_id -> `::` edition uuid (existing rows only; Stage B cataloged them).
  const targetExts = Array.from(new Set(Array.from(subByNft.values()))).map((sub) => `${editionKey}::${sub}`)
  const idByExt = new Map<string, string>()
  const { data: eds } = await supabaseAdmin
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", TS_COLLECTION_ID)
    .in("external_id", targetExts)
  for (const e of (eds ?? []) as Array<{ id: string; external_id: string }>) {
    idByExt.set(e.external_id, e.id)
  }

  for (const row of candidates.values()) {
    if (!row.nft_id) continue
    const sub = subByNft.get(row.nft_id)
    if (!sub) continue
    const targetId = idByExt.get(`${editionKey}::${sub}`)
    if (targetId) row.edition_id = targetId // redirect; else keep base for the re-remap sweep
  }
}

// Collect + insert all historical sales for one resolved (setUuid, playUuid).
async function ingestEditionSales(
  editionId: string,
  setIdInt: string,
  editionKey: string,
  setUuid: string,
  playUuid: string,
  deadlineMs: number,
): Promise<{ found: number; inserted: number; dupes: number; pages: number; error: string | null }> {
  const candidates = new Map<string, SaleRow>() // dedup within batch by txHash
  let pages = 0
  let cursor: string | null = null
  let found = 0
  let synthSeq = 0

  for (let i = 0; i < MAX_TX_PAGES; i++) {
    if (Date.now() > deadlineMs) break // hard wall — pages are recency-DESC so we keep the most recent
    const { txs, nextCursor } = await fetchTxPage(setUuid, playUuid, cursor)
    pages++
    if (txs.length === 0) break
    for (const tx of txs) {
      found++
      // byEditions(playUuid) guarantees the edition; verify the set int when the
      // payload carries it (play.flowID comes back blank on tx payloads).
      const setFlow = tx.moment?.set?.flowId
      if (setFlow != null && String(setFlow) !== setIdInt) continue

      const price = toNum(tx.price)
      if (price === null || price <= 0) continue
      const soldAt = tx.updatedAt
      if (!soldAt) continue

      const serial = toNum(tx.moment?.flowSerialNumber)
      const nftId = tx.moment?.flowId ? String(tx.moment.flowId) : null

      // Prefer the real Flow tx hash; synthesize a DETERMINISTIC fallback so
      // re-runs dedup against themselves.
      let txHash = tx.txHash && tx.txHash.length > 0 ? tx.txHash : null
      if (!txHash) {
        const epoch = Math.floor(new Date(soldAt).getTime() / 1000)
        txHash = `tshist:${setIdInt}:${playUuid}:${serial ?? 0}:${epoch}:${synthSeq++}`
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

  if (candidates.size === 0) return { found, inserted: 0, dupes: 0, pages, error: null }

  // Redirect any parallel-moment sales onto their `::` edition BEFORE dedup/insert.
  await redirectParallelSales(editionKey, candidates)

  // Pre-filter against existing sales (zero-sales targets → usually empty). Read
  // across every edition the candidates now map to (base + any `::` redirects),
  // so the dedup optimization stays effective after the redirect. The per-
  // partition unique index on transaction_hash is the real idempotency backstop.
  const involvedEditionIds = Array.from(new Set(Array.from(candidates.values()).map((r) => r.edition_id)))
  const { data: existing, error: exErr } = await supabaseAdmin
    .from("sales")
    .select("transaction_hash")
    .in("edition_id", involvedEditionIds)
  if (exErr) return { found, inserted: 0, dupes: 0, pages, error: `existing_read: ${exErr.message.slice(0, 180)}` }
  const existingHashes = new Set<string>(
    (existing ?? []).map((r: { transaction_hash: string | null }) => r.transaction_hash).filter(Boolean) as string[],
  )

  const toInsert: SaleRow[] = []
  let dupes = 0
  for (const row of candidates.values()) {
    if (existingHashes.has(row.transaction_hash)) dupes++
    else toInsert.push(row)
  }
  if (toInsert.length === 0) return { found, inserted: 0, dupes, pages, error: null }

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
        else return { found, inserted, dupes, pages, error: `insert: ${rowErr.message.slice(0, 180)}` }
      }
      continue
    }
    return { found, inserted, dupes, pages, error: `insert: ${error.message.slice(0, 180)}` }
  }
  return { found, inserted, dupes, pages, error: null }
}

// Cheap, durable play-uuid fallback: the on-chain OffersV2 indexer stores the
// marketplace play uuid keyed by external_id (setID:playID). Validated 615/615
// against GQL-resolved values (2026-06-19). Covers ~98% of the queue AND the
// premium/Ultimate sets that searchEditions can't surface — the same source the
// pre-seed migration bulk-filled, repeated here so the route is self-sufficient
// for any row edition_offers covers after the one-time seed.
async function resolvePlayUuidFromOffers(editionKey: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("edition_offers")
    .select("play_uuid")
    .eq("collection_id", TS_COLLECTION_ID)
    .eq("external_id", editionKey)
    .not("play_uuid", "is", null)
    .limit(1)
    .maybeSingle()
  return ((data as { play_uuid?: string | null } | null)?.play_uuid as string) ?? null
}

// Drain one target edition: resolve play uuid (cached per set) then ingest.
async function drainEdition(
  editionId: string,
  editionKey: string,
  setUuid: string | null,
  playUuid: string | null,
  attempts: number,
  setMapCache: Map<string, Map<string, string>>,
  deadlineMs: number,
): Promise<EditionResult> {
  const [setIdInt, playIdInt] = editionKey.split(":")
  if (!setIdInt || !playIdInt) {
    return { status: "error", found: 0, inserted: 0, dupes: 0, pages: 0, playUuid, error: "unparseable_edition_key" }
  }
  if (!setUuid) {
    return { status: "error", found: 0, inserted: 0, dupes: 0, pages: 0, playUuid, error: "missing_set_uuid" }
  }

  // Resolve play uuid if we don't have it yet. Prefer the cheap edition_offers
  // lookup (one indexed read, also covers GQL-unmappable Ultimate sets); fall
  // back to the expensive GQL set-map walk only when offers don't have it.
  let resolvedPlayUuid = playUuid
  if (!resolvedPlayUuid) {
    resolvedPlayUuid = await resolvePlayUuidFromOffers(editionKey)
  }
  if (!resolvedPlayUuid) {
    try {
      let map = setMapCache.get(setUuid)
      if (!map) {
        map = await resolveSetPlayMap(setUuid, deadlineMs)
        setMapCache.set(setUuid, map)
      }
      resolvedPlayUuid = map.get(playIdInt) ?? null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
        found: 0, inserted: 0, dupes: 0, pages: 0, playUuid: null,
        error: `setmap: ${msg.slice(0, 180)}`,
      }
    }
    if (!resolvedPlayUuid) {
      // The play isn't in the set's marketplace catalog — no reachable history.
      return { status: "error", found: 0, inserted: 0, dupes: 0, pages: 0, playUuid: null, error: "play_uuid_unresolved" }
    }
  }

  // Ingest sales.
  try {
    const r = await ingestEditionSales(editionId, setIdInt, editionKey, setUuid, resolvedPlayUuid, deadlineMs)
    if (r.error) {
      return {
        status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
        found: r.found, inserted: r.inserted, dupes: r.dupes, pages: r.pages, playUuid: resolvedPlayUuid, error: r.error,
      }
    }
    if (r.found === 0) {
      return { status: "empty", found: 0, inserted: 0, dupes: 0, pages: r.pages, playUuid: resolvedPlayUuid, error: null }
    }
    return { status: "done", found: r.found, inserted: r.inserted, dupes: r.dupes, pages: r.pages, playUuid: resolvedPlayUuid, error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      status: attempts + 1 >= MAX_EDITION_ATTEMPTS ? "error" : "pending",
      found: 0, inserted: 0, dupes: 0, pages: 0, playUuid: resolvedPlayUuid,
      error: `gql: ${msg.slice(0, 180)}`,
    }
  }
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

  const disabled =
    process.env.TS_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.TS_SALES_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const seed = req.nextUrl.searchParams.get("seed") === "true"
  const probeKey = req.nextUrl.searchParams.get("edition")

  // ── Seed mode ──────────────────────────────────────────────────────────────
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

  // ── Dry-run: end-to-end probe of one edition, write NOTHING ────────────────
  if (dryRun) {
    const key = probeKey ?? null
    if (!key || !/^\d+:\d+$/.test(key)) {
      return NextResponse.json({ ok: false, error: "dryRun needs &edition=setID:playID" }, { status: 400 })
    }
    const [setIdInt, playIdInt] = key.split(":")
    try {
      // Resolve set uuid from our DB.
      const { data: ed } = await supabaseAdmin
        .from("editions")
        .select("id, set_id")
        .eq("collection_id", TS_COLLECTION_ID)
        .eq("external_id", key)
        .maybeSingle()
      let setUuid: string | null = null
      if (ed?.set_id) {
        const { data: st } = await supabaseAdmin.from("sets").select("external_id").eq("id", ed.set_id).maybeSingle()
        setUuid = (st?.external_id as string) ?? null
      }
      if (!setUuid || !/^[0-9a-f-]{36}$/.test(setUuid)) {
        return NextResponse.json({ ok: false, mode: "dryRun", edition: key, error: `no_set_uuid (${setUuid})` }, { status: 200 })
      }
      const map = await resolveSetPlayMap(setUuid, startedMs + HARD_CAP_MS)
      const playUuid = map.get(playIdInt) ?? null
      if (!playUuid) {
        return NextResponse.json({ ok: false, mode: "dryRun", edition: key, setUuid, set_plays: map.size, error: "play_uuid_unresolved" }, { status: 200 })
      }
      let cursor: string | null = null
      let pages = 0
      let total = 0
      const sample: Array<{ price: number | null; soldAt: string | null; serial: unknown; txHash: boolean }> = []
      for (let i = 0; i < MAX_TX_PAGES; i++) {
        const { txs, nextCursor } = await fetchTxPage(setUuid, playUuid, cursor)
        pages++
        total += txs.length
        for (const tx of txs) {
          if (sample.length < 5) sample.push({ price: toNum(tx.price), soldAt: tx.updatedAt, serial: tx.moment?.flowSerialNumber ?? null, txHash: !!tx.txHash })
        }
        cursor = nextCursor
        if (txs.length === 0 || !cursor) break
      }
      return NextResponse.json({ ok: true, mode: "dryRun", edition: key, setUuid, playUuid, set_plays: map.size, pages, total_txs: total, sample }, { status: 200 })
    } catch (e) {
      return NextResponse.json({ ok: false, mode: "dryRun", edition: key, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  // ── Self-throttle ──────────────────────────────────────────────────────────
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
    await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, { skipped: "throttle_error" })
    return NextResponse.json({ ok: false, skipped: "throttle_error", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  // ── Pick the next batch of pending targets ─────────────────────────────────
  const { data: targets, error: pickErr } = await supabaseAdmin
    .from("topshot_sales_history_backfill_progress")
    .select("edition_id, edition_key, set_uuid, play_uuid, attempts")
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

  const setMapCache = new Map<string, Map<string, string>>()
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

  for (const t of targets as Array<{
    edition_id: string; edition_key: string; set_uuid: string | null; play_uuid: string | null; attempts: number
  }>) {
    if (Date.now() - startedMs > ELAPSED_BUDGET_MS) {
      budgetHit = true
      break
    }
    processed++
    const res = await drainEdition(t.edition_id, t.edition_key, t.set_uuid, t.play_uuid, t.attempts, setMapCache, hardDeadlineMs)
    totalFound += res.found
    totalInserted += res.inserted
    totalDupes += res.dupes
    if (res.status === "done") editionsDone++
    else if (res.status === "empty") editionsEmpty++
    else if (res.status === "error") editionsError++
    if (res.error?.startsWith("gql:") || res.error?.startsWith("setmap:")) gqlErrors++

    const { error: upErr } = await supabaseAdmin
      .from("topshot_sales_history_backfill_progress")
      .update({
        status: res.status,
        attempts: t.attempts + 1,
        last_attempt_at: new Date().toISOString(),
        play_uuid: res.playUuid,
        sales_inserted: res.inserted,
        dupes_skipped: res.dupes,
        gql_pages: res.pages,
        error: res.error,
        updated_at: new Date().toISOString(),
      })
      .eq("edition_id", t.edition_id)
    if (upErr) console.log(`[${PIPELINE_NAME}] progress update err for ${t.edition_id}: ${upErr.message}`)
  }

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
