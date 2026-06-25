import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// Top Shot FLOWTY-venue UNMAPPED-SALES drain — promotes the resolvable backlog.
//
// Context (2026-06-25): the `topshot-flowty-sales-history-backfill` route walks
// the dead Flowty fork backward and, when its per-tick getMintedMoment budget
// (250) is exhausted, queues the still-unresolved sales into `unmapped_sales`.
// The earlier "99.9% genuinely unresolvable" read was a MEASUREMENT ERROR — it
// only tested the wmc (tracked-holder) path. Direct testing of the backlog vs
// the HOLDER-INDEPENDENT getMintedMoment proved 46/46 resolve to a real
// setID:playID whose edition exists in `editions`. They are real, resolvable
// Top Shot Flowty secondary sales (98.7% sub-$5 dying-Flowty floor dumps),
// backlogged purely by resolution throughput — NOT junk.
//
// This route is the dedicated CONSUMER of that queue: it does ONLY resolution
// (no event scanning, so the whole budget goes to getMintedMoment) and promotes
// each resolved row into `sales`, marking the unmapped row resolved. It also
// fills `nft_edition_map` for every newly-resolved nft so the producer route's
// cheap DB path catches them next time too (shrinks future inflow at the source).
//
// Trevor's decision (2026-06-25): DRAIN into `sales` (data completeness, consistent
// with the 4,572 Flowty sales already accepted there). FMV risk is low — the rows
// are ~3mo old (recency-discounted) and outlier-filtered by fmv-recalc.
//
// SAFETY RAILS (mirror the producer route):
//   • SYNCHRONOUS, no after()/waitUntil. Self-budgets ~200s under the ~300s cap.
//   • Self-throttle on >15 recent non-self pipeline fails.
//   • Idempotent: sales dedup on transaction_hash; promoting an already-present
//     tx is treated as resolved (the unmapped row is still cleared).
//   • Bounded: only acts on the topshot_flowty_history class. The genuine-null
//     tail (burned/unresolvable moments) retires after MAX_DRAIN_ATTEMPTS so it
//     leaves the open backlog instead of being retried forever.
//
// REVERT: every promoted sale carries source='onchain', marketplace='flowty',
//   block_height set, and is keyed by its Flowty tx_hash — the same bounded
//   DELETE that reverts the producer route also removes these:
//     DELETE FROM sales WHERE collection_id='95f28a17-…' AND marketplace='flowty'
//       AND block_height IS NOT NULL;
//   (The unmapped rows can be re-opened: UPDATE unmapped_sales SET resolved_at=NULL,
//    resolved_sale_id=NULL WHERE (resolution_hint->>'backfill')='topshot_flowty_history'.)
//
// Kill switch: disable the cron OR set TOPSHOT_FLOWTY_UNMAPPED_DRAIN_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const PIPELINE_NAME = "topshot-flowty-unmapped-drain"
const BACKFILL_TAG = "topshot_flowty_history"

const CANDIDATE_LIMIT = 500
const GET_MINTED_MAX = 350
const GET_MINTED_DELAY_MS = 60
const ELAPSED_BUDGET_MS = 200_000
const MAX_DRAIN_ATTEMPTS = 4
const SATURATION_FAIL_THRESHOLD = 15

// Only trust canonical int-pair edition_keys (set:play optionally ::sub).
const CANONICAL_KEY = /^[0-9]+:[0-9]+(::[0-9]+)?$/

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// getMintedMoment(nftID) via the topshot-proxy → canonical edition_key + serial.
// Holder-independent: resolves a historical sale's moment regardless of who
// holds it now. Mirrors the sales-indexer / producer-route GQL fallback.
//
// CRITICAL: the proxy rate-limits getMintedMoment to ~55 successes/tick (the very
// reason the producer route queues the rest into unmapped_sales). A null from a
// rate-limit (any non-200 / throw / timeout) is TRANSIENT and must NEVER count
// toward retirement — those rows are resolvable, just throttled. Only a clean
// HTTP-200 whose payload has no set/play is a DEFINITIVE not-found (burned /
// genuinely unresolvable) and eligible to retire. So this returns a status.
type GmResult =
  | { status: "ok"; editionKey: string; serial: number }
  | { status: "not_found" }
  | { status: "transient" }

async function getMintedEdition(nftId: string): Promise<GmResult> {
  try {
    const proxyUrl = process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
    const gqlQuery =
      "query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber play{...on Play{flowID}}set{...on Set{flowId}}}}}}"
    const res = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.TS_PROXY_SECRET ? { "X-Proxy-Secret": process.env.TS_PROXY_SECRET } : {}),
      },
      body: JSON.stringify({ query: gqlQuery, variables: { id: nftId } }),
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return { status: "transient" }
    const json = (await res.json()) as any
    // A GraphQL-level error (incl. proxy/upstream rate-limit surfaced as 200) is transient.
    if (Array.isArray(json?.errors) && json.errors.length > 0) return { status: "transient" }
    const data = json?.data?.getMintedMoment?.data
    const setFlowId = data?.set?.flowId
    const playFlowId = data?.play?.flowID
    if (setFlowId === undefined || setFlowId === null || !playFlowId) return { status: "not_found" }
    const serial = Number(data?.flowSerialNumber)
    return { status: "ok", editionKey: `${setFlowId}:${playFlowId}`, serial: Number.isFinite(serial) && serial > 0 ? serial : 0 }
  } catch {
    return { status: "transient" }
  }
}

interface UnmappedRow {
  id: string
  nft_id: string
  serial_number: number | null
  price_usd: number | string | null
  marketplace: string | null
  transaction_hash: string | null
  block_height: number | null
  sold_at: string
  buyer_address: string | null
  seller_address: string | null
  source: string | null
  resolution_hint: Record<string, unknown> | null
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
      p_cursor_before: null,
      p_cursor_after: null,
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
  const CRON = process.env.CRON_SECRET ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return unauthorized()

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const disabled =
    process.env.TOPSHOT_FLOWTY_UNMAPPED_DRAIN_DISABLED === "1" ||
    process.env.TOPSHOT_FLOWTY_UNMAPPED_DRAIN_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"

  if (!dryRun) {
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
        return NextResponse.json({ ok: true, skipped: "saturation", recent_fails: count }, { status: 200 })
      }
    } catch (e) {
      await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, {})
      return NextResponse.json({ ok: false, skipped: "throttle_error" }, { status: 200 })
    }
  }

  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  let rowsRetired = 0
  let dupSkipped = 0
  const extra: Record<string, unknown> = {}

  try {
    // ── Pull the oldest open, non-retired backlog rows ─────────────────────────
    // Plain indexed-column filter (no PostgREST JSON-path dependency); the
    // backfill-tag + retry gates are applied in JS below. Confirmed live: the
    // open TS flowty/onchain unmapped set IS exactly the topshot_flowty_history
    // backfill class, so this picks up the right rows and nothing else.
    const { data: candidates, error: selErr } = await supabaseAdmin
      .from("unmapped_sales")
      .select(
        "id, nft_id, serial_number, price_usd, marketplace, transaction_hash, block_height, sold_at, buyer_address, seller_address, source, resolution_hint",
      )
      .eq("collection_id", TOPSHOT_COLLECTION_ID)
      .is("resolved_at", null)
      .eq("marketplace", "flowty")
      .eq("source", "onchain")
      .order("ingested_at", { ascending: true })
      .limit(CANDIDATE_LIMIT)
    if (selErr) throw new Error(`candidate select: ${selErr.message}`)

    const rows = ((candidates ?? []) as UnmappedRow[]).filter(
      (r) =>
        (r.resolution_hint?.backfill as string) === BACKFILL_TAG &&
        Number((r.resolution_hint?.drain_attempts as number) ?? 0) < MAX_DRAIN_ATTEMPTS,
    )
    rowsFound = rows.length
    if (rows.length === 0) {
      extra.note = "no_candidates"
      await logRun(startedAt, startedMs, true, 0, 0, 0, null, extra)
      return NextResponse.json({ ok: true, pipeline: PIPELINE_NAME, found: 0, note: "no_candidates" }, { status: 200 })
    }

    const uniqueNftIds = [...new Set(rows.map((r) => r.nft_id))]
    const nftToEditionKey = new Map<string, string>()
    const nftToSerial = new Map<string, number>()

    // ── Tier 1: wmc (cheap) ────────────────────────────────────────────────────
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("moment_id, edition_key, serial_number")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of (data ?? []) as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }>) {
        if (row.edition_key && CANONICAL_KEY.test(row.edition_key)) nftToEditionKey.set(row.moment_id, row.edition_key)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0) nftToSerial.set(row.moment_id, serial)
      }
    }

    // ── Tier 2: nft_edition_map (cheap) ────────────────────────────────────────
    const afterWmc = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
    for (let i = 0; i < afterWmc.length; i += 500) {
      const batch = afterWmc.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("nft_edition_map")
        .select("nft_id, edition_external_id, serial_number")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("nft_id", batch)
      for (const row of (data ?? []) as Array<{ nft_id: string; edition_external_id: string | null; serial_number: number | null }>) {
        if (row.edition_external_id && CANONICAL_KEY.test(row.edition_external_id)) nftToEditionKey.set(row.nft_id, row.edition_external_id)
        const serial = Number(row.serial_number)
        if (Number.isFinite(serial) && serial > 0 && !nftToSerial.has(row.nft_id)) nftToSerial.set(row.nft_id, serial)
      }
    }

    // ── Tier 3: getMintedMoment (holder-independent, budgeted) ─────────────────
    // attemptedNull holds ONLY definitive HTTP-200 not-founds (eligible to retire).
    // Transient (rate-limit) nulls are never added → never falsely retired; they
    // just stay open for the next tick. Bail early once the proxy is clearly
    // rate-limited so we stop hammering it for the rest of the budget.
    const newlyResolved: Array<{ nft_id: string; edition_external_id: string; serial_number: number }> = []
    const attemptedNull = new Set<string>()
    let getMintedUsed = 0
    let transientCount = 0
    let consecutiveTransient = 0
    let rateLimited = false
    const TRANSIENT_BAIL = 20
    for (const id of uniqueNftIds) {
      if (Date.now() > startedMs + ELAPSED_BUDGET_MS) break
      if (getMintedUsed >= GET_MINTED_MAX) break
      if (nftToEditionKey.has(id)) continue
      getMintedUsed++
      const ed = await getMintedEdition(id)
      if (ed.status === "ok") {
        consecutiveTransient = 0
        nftToEditionKey.set(id, ed.editionKey)
        if (ed.serial > 0 && !nftToSerial.has(id)) nftToSerial.set(id, ed.serial)
        newlyResolved.push({ nft_id: id, edition_external_id: ed.editionKey, serial_number: ed.serial })
      } else if (ed.status === "not_found") {
        consecutiveTransient = 0
        attemptedNull.add(id)
      } else {
        // transient — DO NOT bump/retire; retry next tick.
        transientCount++
        consecutiveTransient++
        if (consecutiveTransient >= TRANSIENT_BAIL) {
          rateLimited = true
          break
        }
      }
      await delay(GET_MINTED_DELAY_MS)
    }

    if (newlyResolved.length > 0) {
      const { error: mapErr } = await supabaseAdmin
        .from("nft_edition_map")
        .upsert(
          newlyResolved.map((r) => ({ collection_id: TOPSHOT_COLLECTION_ID, ...r })),
          { onConflict: "collection_id,nft_id", ignoreDuplicates: true },
        )
      if (mapErr) console.log(`[${PIPELINE_NAME}] nft_edition_map upsert err: ${mapErr.message}`)
    }

    // ── Resolve edition_key → edition UUID ─────────────────────────────────────
    const editionKeyToId = new Map<string, string>()
    const editionKeys = [...new Set(nftToEditionKey.values())]
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("editions")
        .select("id, external_id")
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
        .in("external_id", batch)
      for (const row of (data ?? []) as Array<{ id: string; external_id: string }>) editionKeyToId.set(row.external_id, row.id)
    }

    // ── Build sales + decide per-row outcome ───────────────────────────────────
    const ingestedAt = new Date().toISOString()
    const toInsert: Array<{ saleRow: any; unmappedId: string; saleId: string }> = []
    const retireIds: string[] = []
    const bumpAttempt: UnmappedRow[] = []

    for (const r of rows) {
      const editionKey = nftToEditionKey.get(r.nft_id) ?? null
      const editionId = editionKey ? editionKeyToId.get(editionKey) : null
      const price = parseFloat(String(r.price_usd ?? "0")) || 0

      if (editionId) {
        const saleId = crypto.randomUUID()
        toInsert.push({
          unmappedId: r.id,
          saleId,
          saleRow: {
            id: saleId,
            edition_id: editionId,
            collection_id: TOPSHOT_COLLECTION_ID,
            collection: COLLECTION_SLUG,
            nft_id: r.nft_id,
            price_usd: price,
            serial_number: nftToSerial.get(r.nft_id) ?? (Number(r.serial_number) > 0 ? Number(r.serial_number) : 0),
            sold_at: r.sold_at,
            marketplace: r.marketplace ?? "flowty",
            source: r.source ?? "onchain",
            block_height: r.block_height,
            transaction_hash: r.transaction_hash,
            buyer_address: r.buyer_address,
            seller_address: r.seller_address,
            ingested_at: ingestedAt,
          },
        })
      } else if (attemptedNull.has(r.nft_id)) {
        // Got a getMinted attempt this tick and it returned null → bump/retire.
        const attempts = Number((r.resolution_hint?.drain_attempts as number) ?? 0) + 1
        if (attempts >= MAX_DRAIN_ATTEMPTS) {
          retireIds.push(r.id)
        } else {
          bumpAttempt.push({ ...r, resolution_hint: { ...(r.resolution_hint ?? {}), drain_attempts: attempts } })
        }
      }
      // else: not attempted this tick (getMinted budget) → leave untouched, retry next tick.
    }

    if (dryRun) {
      return NextResponse.json(
        {
          ok: true,
          mode: "dryRun",
          candidates: rows.length,
          get_minted_used: getMintedUsed,
          resolvable: toInsert.length,
          would_retire: retireIds.length,
          attempted_null: attemptedNull.size,
        },
        { status: 200 },
      )
    }

    // ── Insert sales (dedup) + mark resolved ───────────────────────────────────
    for (let i = 0; i < toInsert.length; i += 100) {
      const batch = toInsert.slice(i, i + 100)
      const { error } = await supabaseAdmin.from("sales").insert(batch.map((b) => b.saleRow))
      let resolvedBatch = batch
      if (error) {
        if (error.code === "23505" || error.message.includes("duplicate")) {
          // Re-try per-row; a duplicate tx is still "captured" → mark resolved.
          resolvedBatch = []
          for (const b of batch) {
            const { error: se } = await supabaseAdmin.from("sales").insert(b.saleRow)
            if (!se) {
              rowsWritten++
              resolvedBatch.push(b)
            } else if (se.code === "23505" || se.message.includes("duplicate")) {
              dupSkipped++
              resolvedBatch.push(b)
            }
          }
        } else {
          console.log(`[${PIPELINE_NAME}] sales insert err: ${error.message}`)
          resolvedBatch = []
        }
      } else {
        rowsWritten += batch.length
      }
      // Mark the unmapped rows whose sale is now captured.
      for (const b of resolvedBatch) {
        const { error: ue } = await supabaseAdmin
          .from("unmapped_sales")
          .update({ resolved_at: new Date().toISOString(), resolved_sale_id: b.saleId })
          .eq("id", b.unmappedId)
        if (ue) console.log(`[${PIPELINE_NAME}] unmapped resolve update err: ${ue.message}`)
      }
    }

    // ── Retire the genuine-null tail (left the open backlog, not promoted) ──────
    for (const id of retireIds) {
      const row = rows.find((x) => x.id === id)
      const hint = { ...(row?.resolution_hint ?? {}), drain_attempts: MAX_DRAIN_ATTEMPTS, retired: true, retire_reason: "getminted_null" }
      const { error: re } = await supabaseAdmin
        .from("unmapped_sales")
        .update({ resolved_at: new Date().toISOString(), resolution_hint: hint })
        .eq("id", id)
      if (re) console.log(`[${PIPELINE_NAME}] retire update err: ${re.message}`)
      else rowsRetired++
    }

    // ── Bump drain_attempts on the still-null (not yet at the retire threshold) ─
    for (const r of bumpAttempt) {
      const { error: be } = await supabaseAdmin
        .from("unmapped_sales")
        .update({ resolution_hint: r.resolution_hint })
        .eq("id", r.id)
      if (be) console.log(`[${PIPELINE_NAME}] bump update err: ${be.message}`)
    }

    extra.candidates = rows.length
    extra.get_minted_used = getMintedUsed
    extra.editions_resolved = newlyResolved.length
    extra.transient_nulls = transientCount
    extra.rate_limited = rateLimited
    extra.promoted = rowsWritten
    extra.dup_skipped = dupSkipped
    extra.retired = rowsRetired
    extra.bumped = bumpAttempt.length
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] fatal: ${errorMsg}`)
  }

  if (!dryRun) {
    await logRun(startedAt, startedMs, ok, rowsFound, rowsWritten, rowsRetired, errorMsg, extra)
  }

  return NextResponse.json(
    {
      ok,
      pipeline: PIPELINE_NAME,
      found: rowsFound,
      promoted: rowsWritten,
      dup_skipped: dupSkipped,
      retired: rowsRetired,
      error: errorMsg,
    },
    { status: ok ? 200 : 500 },
  )
}

export async function POST(req: NextRequest) {
  return run(req)
}
export async function GET(req: NextRequest) {
  return run(req)
}
