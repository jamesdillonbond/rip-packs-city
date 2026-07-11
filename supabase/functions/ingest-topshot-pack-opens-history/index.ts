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
//   Public sporks bottom out at mainnet17 root = block 27,341,470 (2022-04-06);
//   mainnet16 and older are decommissioned. Top Shot GENESIS (~block 7M, Oct
//   2020) is therefore NOT reachable — TS pack history from 2020-10 → 2022-04-06
//   is permanently unrecoverable via public infrastructure. This fn floors at
//   SPORK_FLOOR (2022-04-06) and walks DOWN from the live-worker backfill
//   boundary (151,610,000) to it. Below-floor is left as an explicit, documented
//   gap, not a bug.
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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const GATE = "rpc_pls_7q4w2z8n_tsopenhist"
const REST = "https://rest-mainnet.onflow.org"
const COLL = "95f28a17-224a-4025-96ad-adf8a4c63bfd" // Top Shot
const OPENED = "A.0b2a3299cc857e29.PackNFT.Opened"
const DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
const CUR_BACK = "topshot_pack_opens_history_backfill"

// ── Spork routing (identical policy to ingest-allday-pack-opens) ─────────────
const CURRENT_SPORK_MIN = 137390146 // mainnet28 root; >= this: rest-mainnet direct
const SPORK_FLOOR = 27341470        // mainnet17 root (2022-04-06); nothing below is recoverable
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
async function getCursor(id: string): Promise<number | null> {
  const { data } = await supabase.from("event_cursor").select("last_processed_block").eq("id", id).maybeSingle()
  return data ? Number(data.last_processed_block) : null
}
async function setCursor(id: string, height: number) {
  await supabase.from("event_cursor").upsert({ id, last_processed_block: height, updated_at: new Date().toISOString() }, { onConflict: "id" })
}

type Open = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null }

// Scan [start,end] for PackNFT.Opened; returns one Open per (tx, pack).
async function scanOpens(start: number, end: number): Promise<{ opens: Open[]; queries: number; err: string | null; transient: boolean }> {
  const opens: Open[] = []
  let queries = 0
  for (let lo = start; lo <= end; lo += EVENT_RANGE) {
    const hi = Math.min(end, lo + EVENT_RANGE - 1)
    queries++
    const res = await eventsFetch(OPENED, lo, hi)
    if (!res.ok) return { opens, queries, err: `events ${lo}-${hi} status ${res.status}`, transient: isTransient(res.status) }
    for (const blk of res.data ?? []) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp ?? null
      for (const ev of blk.events ?? []) {
        const p = dec(ev.payload)
        const packId = prim(field(p, "id"))
        if (packId != null) opens.push({ pack_nft_id: String(packId), tx_hash: ev.transaction_id, block_height: bh, sealed_at: bts })
      }
    }
    await sleep(30)
  }
  return { opens, queries, err: null, transient: false }
}

// For each open tx, fetch results and derive opener + pulled moment count from
// TopShot.Deposit. Historical txs route through the spork-proxy (?tx=).
type RipBuild = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null; opener: string; moments_pulled: number }
async function resolveOpens(opens: Open[], budget: number): Promise<{ rips: RipBuild[]; fetched: number; err: string | null; transient: boolean }> {
  const byTx = new Map<string, Open[]>()
  for (const o of opens) { const a = byTx.get(o.tx_hash) ?? []; a.push(o); byTx.set(o.tx_hash, a) }
  const rips: RipBuild[] = []
  let fetched = 0
  for (const [txh, group] of byTx) {
    if (fetched >= budget) break
    fetched++
    const tr = await txFetch(txh, group[0].block_height)
    if (!tr.ok) { if (isTransient(tr.status)) return { rips, fetched, err: `tx ${txh} status ${tr.status}`, transient: true }; continue }
    const deposits: { id: string; to: string }[] = []
    for (const e of txEvents(tr.data)) {
      if (e.type === DEPOSIT) {
        const p = dec(e.payload)
        const id = prim(field(p, "id")); const to = prim(field(p, "to"))
        if (id != null && to != null) deposits.push({ id: String(id), to: String(to) })
      }
    }
    if (deposits.length === 0) continue // pack opened with no minted moments — skip
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
    await sleep(30)
  }
  return { rips, fetched, err: null, transient: false }
}

async function writeRips(rips: RipBuild[]): Promise<number> {
  if (!rips.length) return 0
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
  return written
}

async function logRun(pipeline: string, startMs: number, ok: boolean, found: number, written: number, cb: number | null, ca: number | null, extra: any, error: string | null) {
  await supabase.from("pipeline_runs").insert({
    pipeline, started_at: new Date(startMs).toISOString(),
    rows_found: found, rows_written: written, cursor_before: cb != null ? String(cb) : null,
    cursor_after: ca != null ? String(ca) : null, ok, error, extra,
  })
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (url.searchParams.get("key") !== GATE) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
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
      let cur = await getCursor(CUR_BACK)
      if (cur == null) { const seed = Math.min(seedStart, t); await setCursor(CUR_BACK, seed); return new Response(JSON.stringify({ mode, init: true, cursor: seed }), { headers: { "content-type": "application/json" } }) }
      if (cur <= floor) { await logRun("topshot-pack-opens-history-backfill", startMs, true, 0, 0, cur, cur, { done: true, floor, spork_available: SPORK_AVAILABLE }, null); return new Response(JSON.stringify({ mode, done: true, cursor: cur, floor, spork_available: SPORK_AVAILABLE }), { headers: { "content-type": "application/json" } }) }
      const end = cur - 1
      let start = Math.max(floor, end - maxBlocks + 1)
      start = Math.max(start, sporkFloorOf(end)) // keep the tick inside one spork
      const { opens, queries, err, transient } = await scanOpens(start, end)
      const { rips, fetched, err: rerr, transient: rtransient } = await resolveOpens(opens, MAX_TX)
      const ripsWritten = await writeRips(rips)
      const anyTransient = (!!err && transient) || (!!rerr && rtransient)
      const skippedPermanent = (!!err || !!rerr) && !anyTransient
      // TRANSIENT -> hold + retry; success/PERMANENT -> advance DOWN (never wedge).
      const after = anyTransient ? cur : start
      if (after < cur) await setCursor(CUR_BACK, after)
      const ok = !anyTransient
      await logRun("topshot-pack-opens-history-backfill", startMs, ok, opens.length, ripsWritten, cur, after,
        { queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr, transient: anyTransient,
          skipped_permanent: skippedPermanent, start, end, floor, spork_available: SPORK_AVAILABLE,
          routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" },
        ok ? null : (err || rerr))
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, cursor_after: after, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr, transient: anyTransient, skipped_permanent: skippedPermanent, spork_available: SPORK_AVAILABLE, routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" }), { headers: { "content-type": "application/json" } })
    }

    return new Response(JSON.stringify({ error: "bad_mode", mode }), { status: 400, headers: { "content-type": "application/json" } })
  } catch (e) {
    await logRun(`topshot-pack-opens-history-${mode}`, startMs, false, 0, 0, null, null, { exception: true }, e instanceof Error ? e.message : String(e))
    return new Response(JSON.stringify({ error: "exception", message: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { "content-type": "application/json" } })
  }
})
