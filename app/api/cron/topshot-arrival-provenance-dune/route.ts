// app/api/cron/topshot-arrival-provenance-dune/route.ts
//
// Top Shot arrival provenance (Dune) — cost basis for held moments our own
// history cannot price. 2026-11-14, Trevor: "keep looking for a source for
// pre-2023 purchases" / "You get it added yourself".
//
// WHY: `sales` has no buyer on any 2020-21 Top Shot sale and the pre-2025-10-22
// Flow history nodes are retired (#181), so ~129k held moments on saved wallets
// had no priced acquisition row. Dune's flow.cadence_events covers 2020 onward.
// Saved query 9129294 takes a list of held moment ids + the saved wallets and,
// per moment, returns its LATEST TopShot.Deposit (the arrival in the wallet that
// holds it now) and what settled IN THAT TRANSACTION for THAT id:
//   k = MP  Market / TopShotMarketV3 .MomentPurchased   (price in DUC = USD)
//   k = LC  NFTStorefront(V2) .ListingCompleted, purchased, DapperUtilityCoin vault
//   k = OC  OffersV2 / Offers .OfferCompleted, purchased, not a FLOW vault
//   k = P   no settlement, Withdraw FROM a Dapper pack-delivery account (pull, $0)
//   k = X/S/T/N  non-USD storefront / self re-deposit / transfer / no withdraw —
//               stored, never written as a cost.
// The first batch (FMV >= $25, 1,945 ids) was run by hand on 2026-11-14 and
// agreed with our own `sales` price on 339/339 overlapping transactions.
//
// Each tick: take the next ≤ BATCH unprobed targets (highest FMV first, FMV ≥
// MIN_FMV), execute 9129294 through the dune-proxy worker, page the results into
// public.topshot_arrival_provenance, mark every target probed (found or not, so
// no id is bought twice), then apply_topshot_arrival_provenance() writes only
// MP/LC/OC/P rows, only for moments still held and still unpriced, archiving
// each write (flowty_archive.acq_chain_arrival_20261114).
//
// ⚠ The dune-proxy worker refuses query ids outside its allowlist. Until 9129294
// is in it (DEFAULT_ALLOWED_QUERY_IDS in workers/dune-proxy/index.ts, deployed,
// or the DUNE_ALLOWED_QUERY_IDS var) /execute returns 403 query_id_not_allowed
// and this lane logs ok=false with that text — it does not pretend to succeed.
//
// Cost: ~70 Dune credits per 2,000-id execution (measured 2026-11-14). When no
// target is left a tick is a clean skip that spends nothing.
//
// ⚠ NOT SCHEDULED, AND SUPERSEDED FOR THE BULK LOAD (2026-11-15). The #190 stage
// route (app/api/cron/stage-topshot-acquisitions-dune) ran the same classification
// wallet-scoped (query 9129489) and loaded 494,427 rows into the same table; 59,283
// were applied 11-14 ~10:10 PM PT. This route stays as the per-batch tool for NEW
// held moments only. It honours the same kill switch, dune_budget_state.paused,
// before any Dune call — paused since 2026-11-15 (Analyst cycle spent, reset Dec 13).
//
// Auth: Bearer ${CRON_SECRET} (vercel.json cron) or ${INGEST_SECRET_TOKEN}.

import { bearerMatches } from "@/lib/auth/bearer-secret"
import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { remainingBudgetMs } from "@/lib/http/sweep-deadline"
import { recordDuneUsage, columnCount } from "@/lib/dune/budget"
import { mapProvenanceRow, type ProvenanceRow } from "@/lib/dune/arrival-provenance"

export const dynamic = "force-dynamic"
export const maxDuration = 800

const PIPELINE_NAME = "topshot-arrival-provenance-dune"
const QUERY_ID = "9129294"
const BATCH = 2000
const MIN_FMV = 1
const PAGE_LIMIT = 1000
const HARD_BUDGET_MS = 720_000
const POLL_MS = 5000
const DUNE_LOG_RESERVE_MS = 30_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function authed(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), "INGEST_SECRET_TOKEN", "CRON_SECRET")
}

export async function GET(req: NextRequest) {
  return run(req)
}
export async function POST(req: NextRequest) {
  return run(req)
}

async function run(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const proxyUrl = process.env.DUNE_PROXY_URL
  const proxySecret = process.env.DUNE_PROXY_SECRET
  const startedAt = new Date().toISOString()
  await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAt) })

  if (!proxyUrl || !proxySecret) {
    const { error } = await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME, p_started_at: startedAt, p_rows_found: 0, p_rows_written: 0,
      p_rows_skipped: 0, p_ok: false, p_error: "dune_not_configured", p_extra: {},
    })
    if (error) console.log(`[${PIPELINE_NAME}] log err: ${error.message}`)
    return NextResponse.json({ ok: false, pipeline: PIPELINE_NAME, error: "dune_not_configured" }, { status: 503 })
  }

  after(async () => {
    const startedMs = Date.now()
    // Every Dune call is bounded by what is left of the sweep budget (less the log reserve).
    const signal = () => AbortSignal.timeout(remainingBudgetMs(startedMs, HARD_BUDGET_MS, { reserveMs: DUNE_LOG_RESERVE_MS }))
    let ok = true
    let errMsg: string | null = null
    let targets = 0
    let found = 0
    let stored = 0
    let skipped = 0
    let probed = 0
    let applied: Record<string, unknown> | null = null
    let skippedReason: string | null = null

    try {
      const { data: tgt, error: tErr } = await supabaseAdmin.rpc("topshot_arrival_probe_targets", { p_limit: BATCH })
      if (tErr) throw new Error(`targets: ${tErr.message}`)
      const list = ((tgt ?? []) as Array<{ wallet: string; nft_id: string; fmv_usd: number | null }>)
        .filter((t) => Number(t.fmv_usd ?? 0) >= MIN_FMV)
      targets = list.length
      if (list.length === 0) {
        skippedReason = "no_targets"
      } else {
        const { data: st, error: stErr } = await supabaseAdmin
          .from("dune_budget_state")
          .select("paused")
          .eq("id", 1)
          .single()
        if (stErr || !st) throw new Error(`dune_budget_state read: ${stErr?.message ?? "no row"}`)
        if (st.paused === true) skippedReason = "dune_paused"
      }
      if (list.length > 0 && skippedReason == null) {
        const ids = Array.from(new Set(list.map((t) => t.nft_id))).join(",")
        const wallets = Array.from(new Set(list.map((t) => t.wallet))).join(",")
        const exRes = await fetch(`${proxyUrl}/execute?query_id=${QUERY_ID}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${proxySecret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query_parameters: { ids, wallets } }),
          cache: "no-store",
          signal: signal(),
        })
        await recordDuneUsage({ pipeline: PIPELINE_NAME, endpoint: "execute", queryId: QUERY_ID, httpStatus: exRes.status, note: `targets=${targets}` })
        if (!exRes.ok) {
          const detail = await exRes.text().catch(() => "<body unreadable>")
          throw new Error(`execute HTTP ${exRes.status}: ${detail.slice(0, 300)}`)
        }
        const execId = ((await exRes.json()) as { execution_id?: string }).execution_id
        if (!execId) throw new Error("no execution_id")

        let completed = false
        while (Date.now() - startedMs < HARD_BUDGET_MS - DUNE_LOG_RESERVE_MS) {
          await sleep(POLL_MS)
          const st = await fetch(`${proxyUrl}/status?execution_id=${encodeURIComponent(execId)}`, {
            headers: { Authorization: `Bearer ${proxySecret}` }, cache: "no-store", signal: signal(),
          })
          if (!st.ok) throw new Error(`status HTTP ${st.status}`)
          const state = ((await st.json()) as { state?: string }).state ?? ""
          if (state === "QUERY_STATE_COMPLETED") { completed = true; break }
          if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED" || state === "QUERY_STATE_EXPIRED") {
            throw new Error(`execution ${execId} ${state}`)
          }
        }
        // Nothing is marked probed on a timeout, so the same targets are retried next tick.
        if (!completed) throw new Error(`execution ${execId} still running at the time budget`)

        let offset = 0
        for (;;) {
          const res = await fetch(`${proxyUrl}/results?query_id=${QUERY_ID}&limit=${PAGE_LIMIT}&offset=${offset}`, {
            headers: { Authorization: `Bearer ${proxySecret}` }, cache: "no-store", signal: signal(),
          })
          if (!res.ok) throw new Error(`results HTTP ${res.status} at offset ${offset}`)
          const j = (await res.json()) as {
            execution_id?: string
            result?: { rows?: Array<Record<string, unknown>> }
            next_offset?: number | null
          }
          // /results returns the query's LATEST execution; refuse anyone else's rows.
          if (j.execution_id && j.execution_id !== execId) {
            throw new Error(`results belong to execution ${j.execution_id}, not ${execId}`)
          }
          const rows = j.result?.rows ?? []
          found += rows.length
          await recordDuneUsage({ pipeline: PIPELINE_NAME, endpoint: "results", queryId: QUERY_ID, rows: rows.length, columns: columnCount(rows), httpStatus: res.status })
          const mapped: ProvenanceRow[] = []
          for (const r of rows) {
            const m = mapProvenanceRow(r)
            if (m) mapped.push(m)
            else skipped++
          }
          if (mapped.length > 0) {
            const { error: insErr, count } = await supabaseAdmin
              .from("topshot_arrival_provenance")
              .upsert(mapped, { onConflict: "wallet,nft_id,arrival_tx", ignoreDuplicates: true, count: "exact" })
            if (insErr) throw new Error(`store: ${insErr.message}`)
            stored += count ?? 0
          }
          if (rows.length < PAGE_LIMIT || j.next_offset == null) break
          offset = Number(j.next_offset)
        }

        // Every target was asked about — mark them all, found or not.
        for (let i = 0; i < list.length; i += 1000) {
          const chunk = list.slice(i, i + 1000).map((t) => ({ wallet: t.wallet, nft_id: t.nft_id }))
          const { error: pErr, count } = await supabaseAdmin
            .from("topshot_arrival_probed")
            .upsert(chunk, { onConflict: "wallet,nft_id", ignoreDuplicates: true, count: "exact" })
          if (pErr) throw new Error(`probed: ${pErr.message}`)
          probed += count ?? 0
        }
      }

      const { data: ap, error: apErr } = await supabaseAdmin.rpc("apply_topshot_arrival_provenance")
      if (apErr) throw new Error(`apply: ${apErr.message}`)
      applied = (ap ?? null) as Record<string, unknown> | null
    } catch (e) {
      ok = false
      errMsg = e instanceof Error ? e.message : String(e)
    }

    const written = Number(applied?.inserted ?? 0) + Number(applied?.updated_unknown ?? 0)
    const { error: logErr } = await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: Number.isFinite(written) ? written : 0,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: errMsg,
      p_extra: {
        targets, stored, probed, applied, skipped_reason: skippedReason,
        query_id: QUERY_ID, duration_ms: Date.now() - startedMs,
      },
    })
    if (logErr) console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${logErr.message}`)
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}
