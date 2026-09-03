import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

// On-chain lock-check pipeline.
//
// Candidates are pulled via the SECDEF helper get_lock_check_batch(slug, limit,
// max_age_days) which prioritises hot wallets (seeded_wallets / saved_wallets)
// first, then any wmc row that has never been lock-checked or whose check is
// older than max_age_days. The route groups by wallet + collection, runs one
// Cadence call per group over the wallet's full moment-id slice, and writes
// back through apply_lock_check_batch(p_results jsonb).
//
// Supported collections:
//   - nba_top_shot (TopShotLocking.isLocked)
//   - disney_pinnacle (Pinnacle.NFT.isLocked — maturity-date primitive verified
//     on-chain via Cadence MCP 2026-05-16)
// AllDay, Golazos, and UFC have no analogous on-chain locking primitive yet —
// candidates for those collections are pulled by get_lock_check_batch but
// returned in the pipeline_runs `unsupported_collections` extra rather than
// being lock-checked. When per-contract lock semantics land, add their slug
// to SLUG_SCRIPTS with a parallel Cadence path.
//
// Bearer auth on INGEST_SECRET_TOKEN. Trevor schedules at cron-job.org every
// 30 min.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "lock-check-batch"
const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"

// Raised 200 -> 400 on 2026-09-02. ⚠ EVERY NUMBER THE OLD COMMENT BLOCK USED TO
// JUSTIFY 200 WAS RE-MEASURED AND IS NOW WRONG — see the corrected block below.
const BATCH_LIMIT = 400

// MAX_AGE_DAYS is a BACKGROUND TARGET, NOT A PROMISE THIS BATCH KEEPS.
//
// Measured 2026-07-19/20: honouring a 7-day re-check across ~1.6M Top Shot wmc
// rows needs ~226,000 checks/day. This batch delivered ~19,200/day (200 rows x
// 48 runs) and delivers ~38,400/day after the 2026-09-02 raise to 400. That is
// still ~6x short, and 1,510,216 rows have never been checked at all (measured
// 2026-09-02) — so a row can sit far longer than 7 days and that is expected,
// not a fault.
//
// The ordered plan this comment used to describe was: 202+after() CRON-30S wrap
// FIRST, then BATCH_LIMIT, then cadence. ✅ Step 1 has since shipped (the
// `after()` + 202 conversion below), so cron-job.org's 30s client cap no longer
// bounds anything — it sees an immediate 202. **Step 2 is this raise.**
//
// ⚠ RE-MEASURED 2026-09-02 BEFORE RAISING, because every number that justified
// 200 was taken under behaviour that no longer exists (pre-dating both the
// covering index and the 2026-09-02 is_user targeting fix):
//
//   claim (2026-07-19)                    | re-measured 2026-09-02
//   --------------------------------------|------------------------------------
//   selection O(limit x hot wallets),      | SUB-LINEAR: 14,965 buffers @200 vs
//     5.8s @200 -> 24.5s @800              |   42,169 @800 (2.8x for 4x rows),
//                                          |   865ms and 728ms — under a second
//   "runs already take 17-27s"             | p50 17.0s / p90 34.5s / max 60.9s
//   p90 241,381ms = 80% of the 300s        | p90 34.5s = 11.5% of budget;
//     ceiling, max 295,604ms (98.5%)       |   max 60.9s = 20%
//
// The two big movers were the covering index and the is_user tier fix, which
// between them cut p90 54.9s -> 34.5s and max 250.7s -> 60.9s.
//
// ⭐ RUNTIME SCALES WITH `wallets_grouped`, NOT WITH ROWS — one Cadence call per
// wallet group (chunked at PER_CADENCE_CHUNK), so a batch of 400 rows spread
// over 22 wallets costs 22 round trips, and the SAME 400 rows on 5 wallets costs
// 5. Measured: 22 wallets -> 30.2s, 18 wallets -> 20.5s (~1.4s/wallet). Sizing
// this on row count is the mistake; watch `extra.wallets_grouped`.
//
// At 400/collection expect roughly double the groups: ~120s worst case against
// the 300,000ms ceiling (40%). ⚠ IF `duration_ms` p90 GOES ABOVE ~180,000ms,
// REVERT TO 200 rather than raising `maxDuration` — a maxDuration kill CANNOT be
// caught (see the heartbeat note below), and the 202 has already told the caller
// the tick succeeded.
//
// ⚠ This doubles BREADTH COVERAGE, not the user-facing freshness guarantee —
// that is the on-view refresh described below. Do not describe it as making
// displayed locks more trustworthy; it makes the background sweep reach twice as
// many rows per day (~19,200 -> ~38,400).
//
// What actually makes displayed locks trustworthy today is the ON-VIEW refresh
// (/api/cache-refresh?refreshLocked=1), which advances the viewed wallet's
// stalest rows on every signed-in collection view. This batch is breadth
// coverage underneath that, not the freshness guarantee.
const MAX_AGE_DAYS = 7

const PER_CADENCE_CHUNK = 50
const PER_CALL_TIMEOUT_MS = 20_000
const SOFT_DEADLINE_MS = 270_000

const TOPSHOT_LOCK_SCRIPT = `
import TopShot from 0x0b2a3299cc857e29
import TopShotLocking from 0x0b2a3299cc857e29

access(all) fun main(addr: Address, ids: [UInt64]): {UInt64: Bool} {
    let acct = getAccount(addr)
    let capRef = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
    if capRef == nil {
        return {}
    }
    let cap = capRef!
    let out: {UInt64: Bool} = {}
    for id in ids {
        let nftRef = cap.borrowMoment(id: id)
        if nftRef == nil {
            continue
        }
        out[id] = TopShotLocking.isLocked(nftRef: nftRef!)
    }
    return out
}
`.trim()

// Pinnacle.NFT.isLocked() is a view fn on the NFT resource that returns true
// when the pin's maturityDate (computed from edition.creationDate +
// edition.maturationPeriod) is still in the future. Non-Maturing Editions
// always return false. Verified via Cadence MCP probe on 0xedf9df96c92f4595
// against a real wallet on 2026-05-16.
const PINNACLE_LOCK_SCRIPT = `
import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595

access(all) fun main(addr: Address, ids: [UInt64]): {UInt64: Bool} {
    let acct = getAccount(addr)
    let capRef = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
    if capRef == nil {
        return {}
    }
    let cap = capRef!
    let out: {UInt64: Bool} = {}
    for id in ids {
        let nftRef = cap.borrowNFT(id)
        if nftRef == nil {
            continue
        }
        let pinRef = nftRef! as! &Pinnacle.NFT
        out[id] = pinRef.isLocked()
    }
    return out
}
`.trim()

const SLUG_SCRIPTS: Record<string, string> = {
  nba_top_shot: TOPSHOT_LOCK_SCRIPT,
  disney_pinnacle: PINNACLE_LOCK_SCRIPT,
}

interface Candidate {
  wallet_address: string
  moment_id: string
  collection_id: string
  collection_slug: string
}

async function runCadenceLock(
  wallet: string,
  ids: string[],
  script: string,
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {}
  for (let i = 0; i < ids.length; i += PER_CADENCE_CHUNK) {
    const chunk = ids.slice(i, i + PER_CADENCE_CHUNK)
    const body = {
      script: btoa(script),
      arguments: [
        btoa(JSON.stringify({ type: "Address", value: wallet })),
        btoa(JSON.stringify({
          type: "Array",
          value: chunk.map(id => ({ type: "UInt64", value: String(id) })),
        })),
      ],
    }
    const res = await fetch(FLOW_REST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    })
    if (!res.ok) {
      throw new Error(`Flow ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const raw = await res.text()
    const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
    const entries: Array<{ key: { value: string }; value: { value: boolean } }> = decoded?.value ?? []
    for (const entry of entries) {
      out[String(entry.key.value)] = !!entry.value.value
    }
  }
  return out
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!TOKEN || bearer !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // CRON-30S: server-side this run always succeeds (pipeline_runs ok=true,
  // ~17-20s typical) but it has spiked past cron-job.org's 30s client cap
  // (33.5s once), showing "Failed" and risking auto-disable. As data grows this
  // gets worse. Fire-and-forget in after() + return 202 now; the existing
  // end-of-run log_pipeline_run is the real signal, and the fatal-catch
  // surfaces a crash before it. (precedent 36eee2f)
  const startedAtIso = new Date().toISOString()
  after(async () => {
    // Invocation heartbeat, written BEFORE the work and awaited.
    //
    // ⚠ `try/catch` CANNOT catch a `maxDuration` kill — the platform terminates
    // the function and takes the terminal `log_pipeline_run` with it, while the
    // 202 above has already told cron-job.org this succeeded. Without a marker
    // written first, a killed tick is indistinguishable from a cron that never
    // fired, and the catch below is NOT a backstop for it.
    //
    // ⭐ This route was selected for conversion on measured kill RISK, not on a
    // suspicion: over 7 days its p90 `duration_ms` is 241,381 ms against this
    // route's 300,000 ms ceiling — **80% of budget at p90**, with a maximum of
    // 295,604 ms (98.5%). The comment above says "~17-20s typical"; that has not
    // been true for some time.
    //
    // ⚠ The marker's name carries the `-heartbeat` suffix (added by the helper,
    // never by the caller) because this pipeline is on
    // `pipeline_cadence_watchlist` — a marker under the REAL name would refresh
    // `last_run` every tick and silence `detect_stalled_pipelines()` on exactly
    // the outage it exists to expose.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAtIso) })
    try {
      await runBatch(startedAtIso)
    } catch (e) {
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAtIso,
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `batch crashed: ${e instanceof Error ? e.message : String(e)}`,
          p_collection_slug: null,
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: { fatal: true },
        })
      } catch {
        // best-effort
      }
    }
  })
  return NextResponse.json({ accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

async function runBatch(startedAtIso: string): Promise<void> {
  const started = Date.parse(startedAtIso)

  // Per-collection batch reads (2026-07-16): the single NULL-slug call put all
  // collections' candidate selection inside ONE 30s service-role statement
  // budget — a cold-cache collision with the :38 cron wave blew it even after
  // the fn was made index-driven (0.17s warm / ~5s cold measured; ticks failed
  // at exactly ~30.1s under saturation). Per-slug calls give each collection
  // its own 30s budget, isolate failures, and add ~zero cost warm. Per-slug
  // limit stays BATCH_LIMIT; the Cadence leg below caps its own work.
  //
  // Scope = only the collections this batch can actually lock-check (2026-07-19,
  // WMC-LOCK-FRESHNESS "scheduling only" decision): Top Shot + Pinnacle have an
  // on-chain isLocked() primitive (SLUG_SCRIPTS). All Day is serviced by its own
  // dedicated scheduler (/api/cron/allday-lock-refresh-batch — its lock is an
  // absent-on-chain DIFF, not isLocked(), so it can't share this framework), and
  // Golazos/UFC have no lock primitive at all. Pulling those three only burned
  // candidate-selection budget and batch slots to write 0 rows (they always
  // landed in `unsupported_collections`). Dropping them focuses every slot on the
  // viewable Top Shot/Pinnacle wallets get_lock_check_batch already prioritises.
  const LOCK_CHECK_SLUGS = ["nba_top_shot", "disney_pinnacle"]
  const candidatesRaw: any[] = []
  const batchReadErrors: string[] = []
  for (const slug of LOCK_CHECK_SLUGS) {
    const { data, error } = await (supabaseAdmin as any).rpc(
      "get_lock_check_batch",
      { p_collection_slug: slug, p_limit: BATCH_LIMIT, p_max_age_days: MAX_AGE_DAYS }
    )
    if (error) {
      batchReadErrors.push(`${slug}: ${error.message}`)
      continue
    }
    for (const r of data ?? []) candidatesRaw.push(r)
  }
  if (batchReadErrors.length === LOCK_CHECK_SLUGS.length) {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 0, p_rows_written: 0, p_rows_skipped: 0,
      p_ok: false, p_error: `get_lock_check_batch: ${batchReadErrors.join(" | ").slice(0, 300)}`,
      p_collection_slug: null, p_cursor_before: null, p_cursor_after: null,
      p_extra: { duration_ms: Date.now() - started, stage: "batch_read" },
    })
    return
  }

  const candidates: Candidate[] = (candidatesRaw ?? []).map((r: any) => ({
    wallet_address: r.out_wallet_address,
    moment_id: r.out_moment_id,
    collection_id: r.out_collection_id,
    collection_slug: r.out_collection_slug,
  }))

  if (candidates.length === 0) {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: 0, p_rows_written: 0, p_rows_skipped: 0,
      p_ok: true, p_error: null, p_collection_slug: null,
      p_cursor_before: null, p_cursor_after: null,
      p_extra: { duration_ms: Date.now() - started, note: "no candidates" },
    })
    return
  }

  // Group by (wallet_address, collection_id) so each wallet's Cadence call is
  // collection-scoped. Unsupported collections collect into a separate bucket
  // so the framework writes 0 rows for them today rather than fabricating
  // results.
  type GroupKey = string
  const groupKey = (w: string, c: string, s: string) => `${w}|${c}|${s}`
  const groups = new Map<GroupKey, Candidate[]>()
  for (const c of candidates) {
    const k = groupKey(c.wallet_address, c.collection_id, c.collection_slug)
    const arr = groups.get(k) ?? []
    arr.push(c)
    groups.set(k, arr)
  }

  const unsupportedCollections: Record<string, number> = {}
  const results: Array<{
    wallet_address: string
    moment_id: string
    collection_id: string
    is_locked: boolean
  }> = []
  const groupErrors: Array<{ wallet: string; slug: string; error: string }> = []
  let walletsProcessed = 0

  for (const [k, items] of groups.entries()) {
    if (Date.now() - started > SOFT_DEADLINE_MS) break
    const [wallet, collectionId, slug] = k.split("|")
    const script = SLUG_SCRIPTS[slug]
    if (!script) {
      unsupportedCollections[slug] = (unsupportedCollections[slug] ?? 0) + items.length
      continue
    }
    const ids = items.map(i => i.moment_id)
    try {
      const locked = await runCadenceLock(wallet, ids, script)
      for (const id of ids) {
        results.push({
          wallet_address: wallet,
          moment_id: id,
          collection_id: collectionId,
          is_locked: !!locked[id],
        })
      }
      walletsProcessed += 1
    } catch (e) {
      groupErrors.push({ wallet, slug, error: e instanceof Error ? e.message : String(e) })
    }
  }

  let inserted = 0
  let writeError: string | null = null
  if (results.length > 0) {
    const { data: applyRes, error: applyErr } = await (supabaseAdmin as any).rpc(
      "apply_lock_check_batch",
      { p_results: results }
    )
    if (applyErr) {
      writeError = applyErr.message
    } else {
      inserted = Number((applyRes as any)?.updated ?? results.length) || results.length
    }
  }

  await (supabaseAdmin as any).rpc("log_pipeline_run", {
    p_pipeline: PIPELINE_NAME,
    p_started_at: startedAtIso,
    p_rows_found: candidates.length,
    p_rows_written: inserted,
    p_rows_skipped: candidates.length - results.length,
    p_ok: !writeError && groupErrors.length === 0,
    p_error: writeError ?? (groupErrors[0] ? `cadence: ${groupErrors[0].error}` : null),
    p_collection_slug: null,
    p_cursor_before: null,
    p_cursor_after: null,
    p_extra: {
      duration_ms: Date.now() - started,
      wallets_processed: walletsProcessed,
      wallets_grouped: groups.size,
      unsupported_collections: unsupportedCollections,
      group_errors: groupErrors.slice(0, 5),
    },
  })

  console.log(
    `[lock-check-batch] done ok=${!writeError && groupErrors.length === 0} found=${candidates.length} written=${inserted} wallets=${walletsProcessed} ms=${Date.now() - started}`
  )
}
