// ingest-topshot-pack-opens-history
// Historical Top Shot pack-OPEN backfill into pack_rips. Sibling to the live
// `pack-events-ingest` worker (which owns the TS forward + near-tip backfill
// cursors) and a near-clone of `ingest-allday-pack-opens` — same scan-Opened +
// resolve-tx shape, same idempotent pack_rips writes, but with Top Shot event
// signatures and spork-proxy deep-history routing.
//
// WHY a separate fn (not another cursor in pack-events-ingest): the worker uses
// rest-mainnet only, which PRUNES pre-current-spork blocks, and touching the
// live worker to add spork routing risks the live ingest path. This fn isolates
// all historical/spork complexity and writes ONLY pack_rips (idempotent), so it
// can never disturb the live pipeline.
//
// Event signatures (mirror workers/pack-events-ingest fetchOpensChunk):
//   A.0b2a3299cc857e29.PackNFT.Opened{ id }      -> pack NFT id (tx_hash source)
//   A.0b2a3299cc857e29.TopShot.Deposit{ id, to } -> each revealed moment (to=opener)
// opener = modal TopShot.Deposit.to ; moments_pulled = count(Deposit to opener).
// tx_hash = the PackNFT.Opened transaction id (identical to how the live worker
// populates pack_rips.tx_hash — so historical rows carry the same real Flow tx).
//
// SCOPE / REACH (hard constraint — see workers/spork-proxy + docs/overnight/focus.md):
//   ⚠ UPDATED 2026-08-07 — the reachable floor MOVED UP. Public sporks used to
//   bottom out at mainnet17 root = 27,341,470 (2022-04-06), but mainnet17–23
//   have since been decommissioned too (measured; see the SPORK_FLOOR comment
//   for the three-way proof). The floor is now the **mainnet24 root =
//   65,264,619 (2023-11-08)**. Top Shot GENESIS (~block 7M, Oct 2020) was
//   already unreachable; as of this change everything before 2023-11-08 is as
//   well. This fn floors at SPORK_FLOOR and walks DOWN from the live-worker
//   backfill boundary (151,610,000) to it. Below-floor is an explicit,
//   documented coverage limit — not a bug, and not a fixable one.
//
// FLAKY-UPSTREAM CHECKPOINTING (2026-08-01): the deep-history sporks fail
// individual /events queries intermittently. A run scans ~100 of them, so an
// all-or-nothing window almost never completes and the cursor never moves —
// the fn logged 41 consecutive failures on one 25k window while the upstream
// was merely flaky, not down. scanOpens now walks DESCENDING and reports
// `scannedFloor`, and the cursor advances to the deepest point actually
// scanned AND resolved. Progress is monotonic under any failure rate.
//
// A run that advanced is ok=true with extra.partial; only a run that moved
// NOTHING is ok=false. rows_skipped now carries the dedup count, so a run that
// re-verifies ground another source already covered (rows_found>0, written=0,
// skipped>0) is distinguishable from one that genuinely found nothing.
//
// NOTE: TS pack_rips from block 61,930,346 up were bulk-loaded on 2026-07-11
// from the Dapper searchPackNft registry, so this fn re-verifies rather than
// discovers across that span. Real discovery was BELOW 61,930,346 — which, as
// of the 2026-08-07 floor raise to 65,264,619, is entirely below the reachable
// floor. So this fn now has NO discovery work left: everything it can still
// reach (>= 65,264,619) is inside the bulk-loaded span it merely re-verifies.
// That is why it correctly reports done:true rather than being "stuck".
//
// Idempotent: pack_rips has UNIQUE(pack_nft_id) AND UNIQUE(tx_hash); we upsert
// onConflict tx_hash ignoreDuplicates (matches the worker's TS rip convention),
// so re-runs and any overlap with the worker's coverage never double-write.
//
// AUTO-GATED on SPORK_PROXY_URL + SPORK_PROXY_SECRET: unset => floor stays at the
// current-spork root (rest-mainnet only; the fn is inert-safe, no 404 flapping);
// set => floor drops to SPORK_FLOOR and historical windows route to the sporks.
//
// Modes (?mode=):
//   probe    — scan a recent window, NO writes; report opens + decode sample.
//   backfill — walk topshot_pack_opens_history_backfill DOWN toward the floor.
// Gated by ?key=; verify_jwt=false. Self-logs to pipeline_runs.
//
// Deliberately writes pack_rips ONLY — NOT moment_acquisitions. Moment-pull
// provenance is owned by the live worker's wallet-walk + flushOpens path; blind
// historical moment_acquisitions writes would risk that system and are out of
// scope for a pack_rips backfill. A follow-up can attribute pulls later off the
// pack_rips rows this fn lands.
import { createClient } from "@supabase/supabase-js"

// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY=<new-random>
const GATE = Deno.env.get("TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY") ?? ""
// Transitional SECOND key, read from its own secret — never a literal (this repo is PUBLIC).
// During a key rotation, set TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY_OLD to the OUTGOING key: both are then accepted, so the
// pg_cron ?key= values can be repointed one job at a time instead of atomically. Finish the
// rotation by DELETING the _OLD secret — no redeploy needed. Both unset ⇒ still fails CLOSED.
const GATE_OLD = Deno.env.get("TOPSHOT_PACK_OPENS_HISTORY_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
}
const REST = "https://rest-mainnet.onflow.org"
const COLL = "95f28a17-224a-4025-96ad-adf8a4c63bfd" // Top Shot
const OPENED = "A.0b2a3299cc857e29.PackNFT.Opened"
const DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
const CUR_BACK = "topshot_pack_opens_history_backfill"

// ── Spork routing (identical policy to ingest-allday-pack-opens) ─────────────
const CURRENT_SPORK_MIN = 137390146 // mainnet28 root; >= this: rest-mainnet direct
// SPORK_FLOOR RAISED 27,341,470 -> 65,264,619 on 2026-08-07 (Trevor-approved).
// 65,264,619 is the **mainnet24 root**. The mainnet17–23 access nodes are
// DECOMMISSIONED, so nothing below this is obtainable from Flow's public
// infrastructure. This is not an inference — it was measured three ways:
//   1. Every spork band <= 65,264,618 returns Cloudflare 522 through
//      spork-proxy; every band above returns 200. A transient outage does not
//      fail precisely at a protocol boundary.
//   2. Probing the origins DIRECTLY (Cloudflare removed from the path):
//      access-001.mainnet22/23...:8070 -> no response; mainnet24/25 -> HTTP 200
//      from the same box, port and method (a real positive control).
//   3. Failure mode: DNS still RESOLVES for mainnet21/22/23 but TCP connect
//      black-holes (connect=0.000000s, 20s timeout) — retired hosts with
//      uncleaned DNS, not a restarting or overloaded service. This worker's own
//      header documents the identical pattern one generation back ("mainnet1–16
//      are decommissioned"); the wave has simply advanced to mainnet23.
// The Archive Node is NOT a fallback: its documented limit is that it "can only
// go back till the start of the current spork".
//
// EFFECT: the backfill cursor was already at 61,808,846 — BELOW this floor —
// so the whole reachable range is ingested and `mode=backfill` now takes the
// `cur <= floor` branch: logs ok=true with done:true, scans nothing, and does
// NOT mutate the cursor. That ends a 15-min retry loop against dead hosts (68
// runs / 0 ok in 24h) which was also paging as `cursor_stalled` — a code-defect
// signal for what is really an upstream decommission.
// Pre-Nov-2023 TS pack-open provenance is now a DISCLOSED COVERAGE LIMIT with a
// stated reason, not an open bug.
// Re-check the boundary any time with: node scripts/probe-spork-bands.mjs
// REVERT: set this back to 27341470 — the cursor is untouched, so the walk
// resumes exactly where it left off if the old sporks ever return.
const SPORK_FLOOR = 65264619        // mainnet24 root (2023-11-08); mainnet17–23 decommissioned
// Default backfill start = the top of the last historical spork (CURRENT_SPORK_MIN
// − 1). The live `pack-events-ingest` worker already owns the CURRENT spork
// (>= 137390146) via its own cursors, so this fn only needs the SUB-spork tail —
// starting here avoids redundantly re-scanning the current spork. A nice side
// effect: with the spork proxy NOT wired, reachableFloor() == 137390146 > this
// start, so the very first backfill tick reports `done` instantly (a safe no-op)
// — the fn does real work only once SPORK_PROXY_* is set. For belt-and-suspenders
// full coverage including the current spork, pass ?start=151610000 (the worker's
// TARGET_END_BLOCK); overlap is idempotent on tx_hash.
const HISTORY_START_BLOCK = 137390145
const SPORK_MAX_HEIGHTS = [
  31735954, 35858810, 40171633, 44950206, 47169686, 55114466,
  65264618, 85981134, 88226266, 130290658, 137390145,
]
const SPORK_URL = (Deno.env.get("SPORK_PROXY_URL") ?? "").replace(/\/+$/, "")
const SPORK_SECRET = Deno.env.get("SPORK_PROXY_SECRET") ?? ""
const SPORK_AVAILABLE = SPORK_URL !== "" && SPORK_SECRET !== ""

function reachableFloor(requested: number): number {
  return SPORK_AVAILABLE ? Math.max(requested, SPORK_FLOOR) : Math.max(requested, CURRENT_SPORK_MIN)
}
function sporkFloorOf(h: number): number {
  if (h >= CURRENT_SPORK_MIN) return CURRENT_SPORK_MIN
  let lo = SPORK_FLOOR
  for (const maxH of SPORK_MAX_HEIGHTS) {
    if (h <= maxH) return lo
    lo = maxH + 1
  }
  return lo
}

const EVENT_RANGE = 250          // Flow REST hard cap per /v1/events query
const MAX_BLOCKS = 25000         // ~100 event queries / run (gentle)
const MAX_TX = 180               // cap tx fetches / run (opens are sparse)

const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function j(url: string, tries = 3, headers: Record<string, string> = {}): Promise<{ ok: true; data: any } | { ok: false; status: number }> {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15000) })
      if (r.ok) return { ok: true, data: await r.json() }
      if ((r.status === 429 || r.status >= 500) && a < tries) { await sleep(400 * a); continue }
      return { ok: false, status: r.status }
    } catch { if (a < tries) { await sleep(400 * a); continue } return { ok: false, status: 0 } }
  }
  return { ok: false, status: 0 }
}
function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}
const sporkHeaders = { Authorization: `Bearer ${SPORK_SECRET}` }
function eventsFetch(type: string, lo: number, hi: number) {
  if (hi < CURRENT_SPORK_MIN && SPORK_AVAILABLE) {
    return j(`${SPORK_URL}/?event_type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`, 3, sporkHeaders)
  }
  return j(`${REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`)
}
function txFetch(txh: string, block: number) {
  if (block < CURRENT_SPORK_MIN && SPORK_AVAILABLE) {
    return j(`${SPORK_URL}/?tx=${txh}`, 3, sporkHeaders)
  }
  return j(`${REST}/v1/transaction_results/${txh}`)
}
function txEvents(data: any): any[] {
  return data?.events ?? data?.result?.events ?? []
}
function dec(b64: string): any { try { return JSON.parse(atob(b64)) } catch { return null } }
function field(ev: any, name: string): any { return ev?.value?.fields?.find((x: any) => x.name === name)?.value }
function prim(v: any): any {
  if (v == null) return null
  if (v.type === "Optional") return prim(v.value)
  if (v.value !== undefined && (typeof v.value !== "object" || v.value === null)) return v.value
  if (v.value && v.value.value !== undefined) return prim(v.value)
  return null
}

async function tip(): Promise<number | null> {
  const r = await j(`${REST}/v1/blocks?height=sealed`)
  if (!r.ok) return null
  return Number(r.data?.[0]?.header?.height ?? 0) || null
}
// See the twin in ingest-allday-pack-opens: dropping `error` here conflates a
// transient read failure with "cursor absent", and the caller's init branch
// then RE-SEEDS the cursor, discarding walk progress. That is how the AllDay
// backfill lost 31.4M blocks on 2026-07-25. Same class here, so same guard.
type CursorRead = { ok: true; value: number | null } | { ok: false; error: string }
async function getCursor(id: string): Promise<CursorRead> {
  const { data, error } = await supabase.from("event_cursor").select("last_processed_block").eq("id", id).maybeSingle()
  if (error) return { ok: false, error: `cursor_read ${id}: ${error.message}` }
  return { ok: true, value: data ? Number(data.last_processed_block) : null }
}
async function setCursor(id: string, height: number) {
  await supabase.from("event_cursor").upsert({ id, last_processed_block: height, updated_at: new Date().toISOString() }, { onConflict: "id" })
}

type Open = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null }

// Scan [start,end] for PackNFT.Opened; returns one Open per (tx, pack).
//
// Scans DESCENDING (end -> start), matching the direction the cursor walks, so
// partial progress is checkpointable: `scannedFloor` is the lowest block we have
// CONFIRMED scanned, i.e. [scannedFloor, end] is complete. An ascending scan
// cannot do this — a mid-window failure leaves a hole above the scanned prefix,
// so the only safe cursor is the unchanged one, and the entire run's work is
// discarded. That is what wedged this fn on 2026-08-01: the deep-history spork
// is FLAKY (not dead — runs failed at query 1,2,3,4,5 in rotation), and a
// 100-query all-or-nothing window essentially never completes against a node
// with a per-query failure rate. Descending + checkpoint makes the walk
// monotonic: every successful chunk is kept, however flaky the upstream.
async function scanOpens(start: number, end: number): Promise<{ opens: Open[]; queries: number; err: string | null; transient: boolean; scannedFloor: number }> {
  const opens: Open[] = []
  let queries = 0
  let hi = end
  while (hi >= start) {
    const lo = Math.max(start, hi - EVENT_RANGE + 1)
    queries++
    const res = await eventsFetch(OPENED, lo, hi)
    // hi+1 is the floor of what we confirmed BEFORE this chunk; the failed chunk
    // itself is not claimed, so the caller re-tries exactly [start, hi] next run.
    if (!res.ok) return { opens, queries, err: `events ${lo}-${hi} status ${res.status}`, transient: isTransient(res.status), scannedFloor: hi + 1 }
    for (const blk of res.data ?? []) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp ?? null
      for (const ev of blk.events ?? []) {
        const p = dec(ev.payload)
        const packId = prim(field(p, "id"))
        if (packId != null) opens.push({ pack_nft_id: String(packId), tx_hash: ev.transaction_id, block_height: bh, sealed_at: bts })
      }
    }
    hi = lo - 1
    await sleep(30)
  }
  return { opens, queries, err: null, transient: false, scannedFloor: start }
}

// For each open tx, fetch results and derive opener + pulled moment count from
// TopShot.Deposit. Historical txs route through the spork-proxy (?tx=).
type RipBuild = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null; opener: string; moments_pulled: number }
// `resolvedFloor` = lowest block whose opens are fully resolved, or null if none
// were. `exhausted` = we stopped early (tx budget or a transient tx failure) with
// opens still unresolved. Together these bound how far the caller may advance the
// cursor: scanning a block is NOT the same as having written its rips, and
// advancing on scan progress alone would drop every open below the stop point.
async function resolveOpens(opens: Open[], budget: number): Promise<{ rips: RipBuild[]; fetched: number; err: string | null; transient: boolean; resolvedFloor: number | null; exhausted: boolean }> {
  const byTx = new Map<string, Open[]>()
  for (const o of opens) { const a = byTx.get(o.tx_hash) ?? []; a.push(o); byTx.set(o.tx_hash, a) }
  const rips: RipBuild[] = []
  let fetched = 0
  let resolvedFloor: number | null = null
  // local const so narrowing holds regardless of closure-capture analysis
  const note = (b: number) => { const prev = resolvedFloor; resolvedFloor = prev == null ? b : Math.min(prev, b) }
  for (const [txh, group] of byTx) {
    if (fetched >= budget) return { rips, fetched, err: null, transient: false, resolvedFloor, exhausted: true }
    fetched++
    const tr = await txFetch(txh, group[0].block_height)
    if (!tr.ok) { if (isTransient(tr.status)) return { rips, fetched, err: `tx ${txh} status ${tr.status}`, transient: true, resolvedFloor, exhausted: true }; note(group[0].block_height); continue }
    const deposits: { id: string; to: string }[] = []
    for (const e of txEvents(tr.data)) {
      if (e.type === DEPOSIT) {
        const p = dec(e.payload)
        const id = prim(field(p, "id")); const to = prim(field(p, "to"))
        if (id != null && to != null) deposits.push({ id: String(id), to: String(to) })
      }
    }
    if (deposits.length === 0) { note(group[0].block_height); continue } // pack opened with no minted moments — skip
    // modal recipient = opener; moments_pulled = deposits handed to the opener
    const counts = new Map<string, number>()
    for (const d of deposits) counts.set(d.to, (counts.get(d.to) ?? 0) + 1)
    let opener = ""; let best = -1
    for (const [to, c] of counts) if (c > best) { best = c; opener = to }
    const pulled = deposits.filter((d) => d.to === opener).length
    const nOpen = group.length
    for (const o of group) {
      rips.push({
        pack_nft_id: o.pack_nft_id, tx_hash: o.tx_hash, block_height: o.block_height, sealed_at: o.sealed_at,
        opener: opener || "0x0",
        // single-pack tx (the norm): all pulls belong to it. multi-pack tx (rare):
        // split evenly + only the first survives the tx_hash unique index.
        moments_pulled: nOpen === 1 ? pulled : Math.ceil(pulled / nOpen),
      })
    }
    note(group[0].block_height)
    await sleep(30)
  }
  return { rips, fetched, err: null, transient: false, resolvedFloor, exhausted: false }
}

// Returns { written, candidates }. `written` is a TRUE insert count (upsert with
// ignoreDuplicates => ON CONFLICT DO NOTHING, so RETURNING yields only new rows),
// which means candidates-minus-written is the DEDUP count. Reporting only
// `written` is what made 239 healthy re-verification runs read as a four-day
// outage on 2026-08-01: a backfill re-walking ground another source already
// covered writes 0 and is working correctly. rows_skipped is the disambiguator.
async function writeRips(rips: RipBuild[]): Promise<{ written: number; candidates: number }> {
  if (!rips.length) return { written: 0, candidates: 0 }
  const seenTx = new Set<string>()
  const ripRows: any[] = []
  for (const r of rips) {
    if (seenTx.has(r.tx_hash)) continue
    seenTx.add(r.tx_hash)
    ripRows.push({
      collection_id: COLL, pack_nft_id: r.pack_nft_id, opener_address: r.opener,
      moments_pulled: r.moments_pulled, tx_hash: r.tx_hash, block_height: r.block_height,
      sealed_at: r.sealed_at, dist_id: null, // TS dist resolves later via backfill_pack_rip_metadata
    })
  }
  let written = 0
  for (let i = 0; i < ripRows.length; i += 500) {
    const { data, error } = await supabase.from("pack_rips")
      .upsert(ripRows.slice(i, i + 500), { onConflict: "tx_hash", ignoreDuplicates: true }).select("id")
    if (error) throw new Error("pack_rips upsert: " + error.message)
    written += data?.length ?? 0
  }
  return { written, candidates: ripRows.length }
}

async function logRun(pipeline: string, startMs: number, ok: boolean, found: number, written: number, skipped: number, cb: number | null, ca: number | null, extra: any, error: string | null) {
  await supabase.from("pipeline_runs").insert({
    pipeline, started_at: new Date(startMs).toISOString(),
    rows_found: found, rows_written: written, rows_skipped: skipped,
    cursor_before: cb != null ? String(cb) : null,
    cursor_after: ca != null ? String(ca) : null, ok, error, extra,
  })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (!gateKeyOk(url.searchParams.get("key"))) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  const mode = url.searchParams.get("mode") ?? "probe"
  const requestedFloor = Number(url.searchParams.get("floor") ?? SPORK_FLOOR)
  const floor = reachableFloor(requestedFloor)
  const seedStart = Number(url.searchParams.get("start") ?? HISTORY_START_BLOCK)
  const maxBlocks = Number(url.searchParams.get("blocks") ?? MAX_BLOCKS)
  const startMs = Date.now()
  const t = await tip()
  if (!t) return new Response(JSON.stringify({ error: "tip_unreachable" }), { status: 200, headers: { "content-type": "application/json" } })

  try {
    if (mode === "probe") {
      // Probe a recent below-tip historical window to exercise the spork path
      // when wired; otherwise a current-spork window.
      const end = Math.min(seedStart, t)
      const start = Math.max(floor, sporkFloorOf(end), end - maxBlocks + 1)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched } = await resolveOpens(opens.slice(0, 20), 20)
      return new Response(JSON.stringify({ mode, tip: t, start, end, queries, opens_found: opens.length, sample_resolved: rips.length, tx_fetched: fetched, scan_err: err,
        spork_available: SPORK_AVAILABLE, routed: end < CURRENT_SPORK_MIN ? "spork" : "rest",
        sample: rips.slice(0, 3).map((r) => ({ pack: r.pack_nft_id, opener: r.opener, pulls: r.moments_pulled, tx: r.tx_hash })) }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "backfill") {
      const curRead = await getCursor(CUR_BACK)
      if (!curRead.ok) { await logRun("topshot-pack-opens-history-backfill", startMs, false, 0, 0, 0, null, null, { cursor_read_failed: true }, curRead.error); return new Response(JSON.stringify({ mode, error: "cursor_read_failed", detail: curRead.error }), { headers: { "content-type": "application/json" } }) }
      const cur = curRead.value
      if (cur == null) { const seed = Math.min(seedStart, t); await setCursor(CUR_BACK, seed); return new Response(JSON.stringify({ mode, init: true, cursor: seed }), { headers: { "content-type": "application/json" } }) }
      if (cur <= floor) { await logRun("topshot-pack-opens-history-backfill", startMs, true, 0, 0, 0, cur, cur, { done: true, floor, spork_available: SPORK_AVAILABLE }, null); return new Response(JSON.stringify({ mode, done: true, cursor: cur, floor, spork_available: SPORK_AVAILABLE }), { headers: { "content-type": "application/json" } }) }
      const end = cur - 1
      let start = Math.max(floor, end - maxBlocks + 1)
      start = Math.max(start, sporkFloorOf(end)) // keep the tick inside one spork
      const { opens, queries, err, transient, scannedFloor } = await scanOpens(start, end)
      const { rips, fetched, err: rerr, transient: rtransient, resolvedFloor, exhausted } = await resolveOpens(opens, MAX_TX)
      const { written: ripsWritten, candidates } = await writeRips(rips)
      const anyTransient = (!!err && transient) || (!!rerr && rtransient)
      const skippedPermanent = (!!err || !!rerr) && !anyTransient

      // Cursor floor for this tick = the lowest block we both SCANNED and — where
      // it carried opens — RESOLVED. Scanning is not enough on its own: if the tx
      // budget ran out or a tx read failed, advancing on scan progress would step
      // over opens we never wrote. resolvedFloor is null only when no tx was
      // processed at all, in which case we hold.
      let after = scannedFloor
      if (exhausted) after = Math.max(after, resolvedFloor ?? cur)
      after = Math.min(after, cur)   // never walk back up
      after = Math.max(after, floor) // never below the reachable floor
      if (after < cur) await setCursor(CUR_BACK, after)

      const progressed = after < cur
      const anyErr = !!err || !!rerr
      // A checkpointed run that ADVANCED did its job even if the flaky spork
      // failed a later chunk; the failure stays visible in extra.scan_err +
      // extra.partial. Only a run that moved NOTHING is a real wedge — that is
      // the one that stays ok=false and pages.
      const ok = progressed || !anyErr
      const rowsSkipped = candidates - ripsWritten
      await logRun("topshot-pack-opens-history-backfill", startMs, ok, opens.length, ripsWritten, rowsSkipped, cur, after,
        { queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr, transient: anyTransient,
          skipped_permanent: skippedPermanent, partial: anyErr && progressed, progress_blocks: cur - after,
          scanned_floor: scannedFloor, resolved_floor: resolvedFloor, resolve_exhausted: exhausted,
          rows_deduped: rowsSkipped, start, end, floor, spork_available: SPORK_AVAILABLE,
          routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" },
        ok ? null : (err || rerr))
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, rows_deduped: rowsSkipped, cursor_after: after, progressed, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr, transient: anyTransient, skipped_permanent: skippedPermanent, spork_available: SPORK_AVAILABLE, routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" }), { headers: { "content-type": "application/json" } })
    }

    return new Response(JSON.stringify({ error: "bad_mode", mode }), { status: 400, headers: { "content-type": "application/json" } })
  } catch (e) {
    await logRun(`topshot-pack-opens-history-${mode}`, startMs, false, 0, 0, 0, null, null, { exception: true }, e instanceof Error ? e.message : String(e))
    return new Response(JSON.stringify({ error: "exception", message: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { "content-type": "application/json" } })
  }
})
