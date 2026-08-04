// app/api/cron/golazos-discover-buyers/route.ts
//
// Buyer-derived wallet DISCOVERY for LaLiga Golazos.
//
// THE GAP THIS CLOSES (measured 2026-08-04): every wallet ever scanned for
// Golazos came from the curated `seeded_wallets` list — 268 distinct, all
// collection-agnostic — and `wallet_backfill_state` for Golazos held 269. There
// was NO organic wallet discovery from sales at all, so our Golazos holdings
// view was a curated panel, not the market. The visible cost: 47 unresolved
// priced Golazos sales across 17 buyers (source `onchain_dapper_v2`, newest
// 2026-08-01, 17 of them inside 30d), none of which had ever been scanned in
// ANY collection. `promote_unmapped_sales` Path 4 maps a sale via
// `wmc.edition_key`, so with the holder never scanned there is nothing to map
// to and the sale can never resolve.
//
// ── WHY THIS IS A DISPATCHER, NOT A QUEUE WRITER ───────────────────────────
// Two tables look like the place to "enqueue" a wallet. Both are wrong:
//
//   wallet_backfill_state — a record of scans ALREADY PERFORMED, written by the
//     scanner itself via record_wallet_backfill_scan(). `last_scanned_at`
//     DEFAULTs to now() and `scan_count` to 1, so inserting a row here marks a
//     wallet as scanned and can SUPPRESS the very scan we want.
//   seeded_wallets — a human-curated outreach list carrying username,
//     display_name, notes, tags, priority, is_pro_user, invite_count. Injecting
//     anonymous buyer addresses would corrupt a curated list to achieve a scan.
//
// So discovery DISPATCHES a real scan (/api/wallet-backfill-golazos) and lets
// that scan write its own state row on completion. That also makes the whole
// thing self-draining and idempotent: once a candidate is scanned it acquires a
// wallet_backfill_state row and is never selected again, whatever the scan
// found — including a legitimately empty wallet.
//
// ── BOUNDING ────────────────────────────────────────────────────────────────
// Candidates are bounded three ways:
//   1. buyer_address IS NULL is excluded. No wallet-based path can ever resolve
//      those (4,390 such rows exist on AllDay); they are a different defect.
//   2. EXCLUDED_ADDRESSES — the repo's canonical curated set of addresses that
//      appear in a Flowty/Dapper purchase envelope but are never the buyer.
//      This is deliberately used INSTEAD of a statistical "high purchase count
//      + zero wmc rows" aggregator heuristic, for two reasons. First, the
//      statistical test is CIRCULAR here: wmc rows are populated BY scanning,
//      so every never-scanned candidate has zero of them by construction and
//      the test would either exclude everything or reduce to an unvalidated
//      arbitrary cut on purchase count. Second, the curated set already covers
//      the exact addresses the heuristic was reaching for — the Flowty
//      storefront escrow 0x3cdbb3d569211ff3 and the AllDay contract account
//      0xe4cf4bdc1751c65d. Verified 2026-08-04: applied to the live Golazos
//      candidate set it takes 18 -> 17, removing exactly the Flowty escrow
//      (40 unresolved sales, dead lane, newest 2026-04-14) and independently
//      reproducing the 17 real collectors found by hand.
//   3. MAX_DISPATCH per tick, so a surprise flood can never fan out unbounded.
//
// Deliberately NOT filtered by `source`: the dead flowty lane's only buyer is
// the escrow address, which rule 2 already removes, so a source filter would
// buy nothing while blinding discovery to any future marketplace lane.
//
// Auth: Bearer INGEST_SECRET_TOKEN or CRON_SECRET. Both are required —
// Vercel Cron sends ONLY CRON_SECRET, and accepting just INGEST_SECRET_TOKEN is
// what made /api/cron/pinnacle-sync 401 on every tick for months.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  EXCLUDED_ADDRESSES,
  normalizeAddress,
} from "@/lib/chains/flow/allday-edition-onchain"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "golazos-buyer-discovery"
const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"

// Unresolved priced rows pulled per tick. PostgREST caps a bare select at 1000
// and silently CLAMPS a larger explicit limit, so this is set at the cap and
// the tick reports `candidate_rows_capped` when it is hit rather than quietly
// pretending it saw the whole backlog.
const UNMAPPED_FETCH = 1000

// Wallet scans dispatched per tick. The live candidate set is 17, so this
// drains in a single tick; the cap exists so an unexpected backlog spike
// cannot fan out unbounded onto the Supabase pool.
const MAX_DISPATCH = 25

// Each dispatch returns 202 immediately. This gap keeps a burst of scan
// lambdas from landing on the 60-conn pool at the same instant — the
// saturation class documented in seed-wallet-refresh's dispatch pacing.
// Env-tunable so the operator can widen it without a redeploy; a NaN/garbage
// value falls back to the default rather than propagating NaN into sleep().
// Read per-run, not at module load, so the env takes effect without waiting
// for a cold start.
const DISPATCH_GAP_DEFAULT_MS = 400
function dispatchGapMs(): number {
  const raw = Number(process.env.GOLAZOS_DISCOVERY_GAP_MS)
  return Number.isFinite(raw) ? Math.max(0, raw) : DISPATCH_GAP_DEFAULT_MS
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function authed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  return (
    !!bearer &&
    (bearer === process.env.INGEST_SECRET_TOKEN ||
      bearer === process.env.CRON_SECRET)
  )
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}

function handle(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin
  const startedAtIso = new Date().toISOString()

  after(async () => {
    try {
      await runDiscovery(origin, startedAtIso)
    } catch (e) {
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAtIso,
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `discovery crashed: ${e instanceof Error ? e.message : String(e)}`,
          p_extra: { fatal: true },
        })
      } catch {
        /* best-effort */
      }
    }
  })

  return NextResponse.json(
    { accepted: true, pipeline: PIPELINE_NAME, started_at: startedAtIso },
    { status: 202 }
  )
}

async function logRun(
  startedAtIso: string,
  ok: boolean,
  error: string | null,
  extra: Record<string, unknown>,
  found = 0,
  written = 0,
  skipped = 0
): Promise<void> {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: error ? error.slice(0, 300) : null,
      p_extra: extra,
    })
  } catch {
    /* best-effort */
  }
}

export async function runDiscovery(
  origin: string,
  startedAtIso: string
): Promise<void> {
  const started = Date.parse(startedAtIso)
  const ingestToken = process.env.INGEST_SECRET_TOKEN ?? ""

  // 1. Unresolved, PRICED Golazos sales that actually name a buyer.
  //    Newest first so that if the cap is ever hit we keep the most recent
  //    (and most product-relevant) buyers rather than an arbitrary slice.
  const { data: rows, error: rowsErr } = await (supabaseAdmin as any)
    .from("unmapped_sales")
    .select("buyer_address")
    .eq("collection_id", GOLAZOS_COLLECTION_ID)
    .is("resolved_at", null)
    .gt("price_usd", 0)
    .not("buyer_address", "is", null)
    .order("sold_at", { ascending: false })
    .limit(UNMAPPED_FETCH)

  if (rowsErr) {
    await logRun(startedAtIso, false, `unmapped fetch: ${rowsErr.message}`, {
      stage: "unmapped_fetch",
    })
    return
  }

  const unmappedRows: Array<{ buyer_address: string | null }> = rows ?? []
  const capped = unmappedRows.length >= UNMAPPED_FETCH

  // 2. Distinct buyers, minus the never-a-buyer envelope addresses.
  const seen = new Set<string>()
  let excludedEnvelope = 0
  for (const r of unmappedRows) {
    if (!r.buyer_address) continue
    const addr = normalizeAddress(r.buyer_address)
    if (EXCLUDED_ADDRESSES.has(addr)) {
      excludedEnvelope++
      continue
    }
    seen.add(addr)
  }
  const distinctBuyers = Array.from(seen)

  // 3. Drop anyone already scanned for Golazos. A state row means a scan ran —
  //    whatever it found — so re-dispatching would just re-walk a wallet whose
  //    sale is unresolved for some other reason.
  let alreadyScanned = 0
  let candidates = distinctBuyers
  if (distinctBuyers.length > 0) {
    const { data: state, error: stateErr } = await (supabaseAdmin as any)
      .from("wallet_backfill_state")
      .select("wallet_address")
      .eq("collection_id", GOLAZOS_COLLECTION_ID)
      .in("wallet_address", distinctBuyers)

    if (stateErr) {
      await logRun(startedAtIso, false, `state fetch: ${stateErr.message}`, {
        stage: "state_fetch",
        distinct_buyers: distinctBuyers.length,
      })
      return
    }

    const scanned = new Set<string>(
      ((state ?? []) as Array<{ wallet_address: string }>).map((s) =>
        normalizeAddress(s.wallet_address)
      )
    )
    candidates = distinctBuyers.filter((w) => !scanned.has(w))
    alreadyScanned = distinctBuyers.length - candidates.length
  }

  const overCap = Math.max(0, candidates.length - MAX_DISPATCH)
  const toDispatch = candidates.slice(0, MAX_DISPATCH)

  // 4. Dispatch a real Golazos scan per candidate. The scan writes its own
  //    wallet_backfill_state row, which is what removes it from this set.
  let dispatched = 0
  const failures: Array<{ wallet: string; error: string }> = []
  const gapMs = dispatchGapMs()

  for (const wallet of toDispatch) {
    try {
      const res = await fetch(origin + "/api/wallet-backfill-golazos", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestToken}`,
        },
        // force a full walk: a never-scanned wallet has no cache to diff against
        body: JSON.stringify({ wallet, skip_cached: false }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 202 || res.ok) {
        dispatched++
      } else {
        failures.push({ wallet, error: `http ${res.status}` })
      }
    } catch (e) {
      failures.push({
        wallet,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    await sleep(gapMs)
  }

  await logRun(
    startedAtIso,
    failures.length === 0,
    failures[0]
      ? `dispatch ${failures[0].wallet}: ${failures[0].error}`
      : null,
    {
      duration_ms: Date.now() - started,
      unmapped_rows: unmappedRows.length,
      // Surfaced, never silent: a capped fetch means this tick did NOT see the
      // whole backlog, and the next tick picks up the remainder.
      candidate_rows_capped: capped,
      distinct_buyers: distinctBuyers.length,
      excluded_envelope_addresses: excludedEnvelope,
      already_scanned: alreadyScanned,
      candidates: candidates.length,
      dispatched,
      deferred_over_cap: overCap,
      failures: failures.slice(0, 5),
    },
    candidates.length,
    dispatched,
    alreadyScanned + overCap
  )
}
