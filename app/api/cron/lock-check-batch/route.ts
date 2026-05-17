import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

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

const BATCH_LIMIT = 200
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

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  const { data: candidatesRaw, error: batchErr } = await (supabaseAdmin as any).rpc(
    "get_lock_check_batch",
    { p_collection_slug: null, p_limit: BATCH_LIMIT, p_max_age_days: MAX_AGE_DAYS }
  )
  if (batchErr) {
    return NextResponse.json({ ok: false, error: batchErr.message }, { status: 500 })
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
    return NextResponse.json({ ok: true, rows_found: 0, rows_written: 0 })
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

  return NextResponse.json({
    ok: !writeError && groupErrors.length === 0,
    rows_found: candidates.length,
    rows_written: inserted,
    wallets_processed: walletsProcessed,
    unsupported_collections: unsupportedCollections,
  })
}
