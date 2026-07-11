// ingest-allday-pack-opens
// Ingests NFL All Day pack-OPEN events into pack_rips (+ per-pull moment ids
// into allday_pack_pull) directly from Flow REST — reachable from Supabase
// egress, no proxy/secret. Mirrors the backfill-allday-pack-supply scaffold.
//
// Verified signature (open tx bf5e22c6...):
//   PackNFT.Opened{ id }                  -> the pack NFT id (1 per pack opened)
//   AllDay.Deposit{ id, to }              -> each revealed moment (to = opener)
//   AllDay.Withdraw{ id, from=0xb6f2...}  -> reveal source (mint vault) [unused]
// opener = modal AllDay.Deposit.to ; moments_pulled = count(AllDay.Deposit).
//
// Idempotent: pack_rips has UNIQUE(pack_nft_id) AND UNIQUE(tx_hash) already, so
// upsert ignoreDuplicates never double-writes. AllDay pack ids are large ints
// that never collide with the integer TS pack ids.
//
// Modes (?mode=):
//   probe    — scan a recent window, NO writes; report opens + decode sample.
//   forward  — advance the forward cursor up to tip (catches new opens).
//   backfill — walk the backfill cursor down toward FLOOR (historical tail).
// Gated by ?key=; verify_jwt=false. Self-logs to pipeline_runs.
//
// DEEP-HISTORY (2026-07-11): the backfill can now reach AllDay genesis
// (~35–40M) by routing sub-current-spork windows through the spork-proxy
// worker (workers/spork-proxy). See "Spork routing" below. This is AUTO-GATED
// on SPORK_PROXY_URL + SPORK_PROXY_SECRET being present in the fn env: unset =>
// today's safe behavior (floor stays at the current-spork root, no flapping);
// set => floor drops to AllDay genesis and historical windows route to the
// spork nodes. Forward/probe paths are unchanged (they only ever touch
// >= CURRENT_SPORK_MIN heights, which always use rest-mainnet).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const GATE = "rpc_pls_8x2f9k3m_alldayopen"
const REST = "https://rest-mainnet.onflow.org"
const COLL = "dee28451-5d62-409e-a1ad-a83f763ac070"
const OPENED = "A.e4cf4bdc1751c65d.PackNFT.Opened"
const DEPOSIT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const CUR_FWD = "allday_pack_opens_forward"
const CUR_BACK = "allday_pack_opens_backfill"

// ── Spork routing ───────────────────────────────────────────────────────────
// rest-mainnet.onflow.org only serves the CURRENT spork (>= CURRENT_SPORK_MIN);
// it PRUNES older blocks (404). Deep history is reachable only via the
// spork-proxy worker, which fronts the port-8070 historical access nodes.
//
//   CURRENT_SPORK_MIN — mainnet28 root. Blocks >= this: rest-mainnet direct.
//   SPORK_FLOOR       — mainnet17 root (2022-04-06). The public sporks bottom
//                       out here; mainnet16 and older are decommissioned, so
//                       nothing below SPORK_FLOOR is recoverable by ANY path.
//   ALLDAY_GENESIS_FLOOR — target floor for the backfill when spork access is
//                       available (AllDay's first PackNFT.Opened is ~35–40M,
//                       comfortably above SPORK_FLOOR). Overridable via ?floor=.
//   SPORK_MAX_HEIGHTS — per-spork upper block (next spork root − 1), ascending;
//                       must match workers/spork-proxy SPORKS. A spork-proxy
//                       events query may not cross a spork boundary, so each
//                       backfill tick is clamped to a single spork below.
const CURRENT_SPORK_MIN = 137390146
const SPORK_FLOOR = 27341470
const ALLDAY_GENESIS_FLOOR = 35000000
const SPORK_MAX_HEIGHTS = [
  31735954, 35858810, 40171633, 44950206, 47169686, 55114466,
  65264618, 85981134, 88226266, 130290658, 137390145,
]
const SPORK_URL = (Deno.env.get("SPORK_PROXY_URL") ?? "").replace(/\/+$/, "")
const SPORK_SECRET = Deno.env.get("SPORK_PROXY_SECRET") ?? ""
const SPORK_AVAILABLE = SPORK_URL !== "" && SPORK_SECRET !== ""

// Lowest block reachable at all right now: SPORK_FLOOR if the proxy is wired,
// else the current-spork root (rest-mainnet only). Anything the caller asks for
// below this is clamped up to it, so the backfill terminates instead of 404ing.
function reachableFloor(requested: number): number {
  return SPORK_AVAILABLE ? Math.max(requested, SPORK_FLOOR) : Math.max(requested, CURRENT_SPORK_MIN)
}
// Lowest block of the spork that contains `h` (so a tick window stays inside one
// spork — the spork-proxy events endpoint rejects cross-boundary ranges).
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
const MAX_TX = 180               // cap tx_results fetches / run (opens are sparse)

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
// A transient error is worth retrying the same window on the next tick (network
// blip / rate-limit / node 5xx). A PERMANENT error (404 pruned block, 400/401
// from the proxy, etc.) means the window will never succeed — the backfill must
// SKIP past it rather than wedge forever (the pre-2026-07-11 loop bug: every
// error held the cursor, so a pruned window retried the identical range each
// tick). status 0 = fetch threw (treat as transient).
function isTransient(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}
const sporkHeaders = { Authorization: `Bearer ${SPORK_SECRET}` }
// Events query, routed by height. Windows are clamped to a single spork by the
// caller, so [lo,hi] never crosses CURRENT_SPORK_MIN or a spork boundary.
function eventsFetch(type: string, lo: number, hi: number) {
  if (hi < CURRENT_SPORK_MIN && SPORK_AVAILABLE) {
    return j(`${SPORK_URL}/?event_type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`, 3, sporkHeaders)
  }
  return j(`${REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`)
}
// Transaction result, routed by the open's block height. rest-mainnet exposes
// /v1/transaction_results/{tx} (events at top level); the spork-proxy returns
// /v1/transactions/{tx}?expand=result (events under .result.events). Callers
// read events via txEvents() to normalize the two shapes.
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
function prim(v: any): any { // unwrap typed/Optional JSON-CDC to a primitive
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
// [start,end] must sit within a single spork (caller guarantees) so eventsFetch
// routes the whole scan to one node. On the first failed query it returns the
// error + whether it was transient (retry) or permanent (skip the window).
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

// For a set of open txs, fetch tx_results and derive opener + pulled moments.
type RipBuild = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null; opener: string; pulls: string[] }
async function resolveOpens(opens: Open[], budget: number): Promise<{ rips: RipBuild[]; fetched: number; err: string | null; transient: boolean }> {
  // group by tx (a tx normally opens exactly one pack)
  const byTx = new Map<string, Open[]>()
  for (const o of opens) { const a = byTx.get(o.tx_hash) ?? []; a.push(o); byTx.set(o.tx_hash, a) }
  const rips: RipBuild[] = []
  let fetched = 0
  for (const [txh, group] of byTx) {
    if (fetched >= budget) break
    fetched++
    // Route by the open's block: historical txs are pruned from rest-mainnet and
    // must go through the spork-proxy (?tx=). A transient failure aborts the
    // batch (caller retries); a permanent one skips just this tx (the other
    // opens in the window still resolve).
    const tr = await txFetch(txh, group[0].block_height)
    if (!tr.ok) { if (isTransient(tr.status)) return { rips, fetched, err: `tx ${txh} status ${tr.status}`, transient: true }; continue }
    // collect AllDay.Deposit (moment id + recipient)
    const deposits: { id: string; to: string }[] = []
    for (const e of txEvents(tr.data)) {
      if (e.type === DEPOSIT) {
        const p = dec(e.payload)
        const id = prim(field(p, "id")); const to = prim(field(p, "to"))
        if (id != null && to != null) deposits.push({ id: String(id), to: String(to) })
      }
    }
    // modal recipient = opener
    const counts = new Map<string, number>()
    for (const d of deposits) counts.set(d.to, (counts.get(d.to) ?? 0) + 1)
    let opener = ""; let best = -1
    for (const [to, c] of counts) if (c > best) { best = c; opener = to }
    const pulls = deposits.filter((d) => d.to === opener).map((d) => d.id)
    const nOpen = group.length
    for (const o of group) {
      rips.push({
        pack_nft_id: o.pack_nft_id, tx_hash: o.tx_hash, block_height: o.block_height, sealed_at: o.sealed_at,
        opener: opener || "0x0",
        // single-pack tx (the norm): all pulls belong to it. multi-pack tx (rare):
        // split evenly + only the first survives the tx_hash unique index.
        pulls: nOpen === 1 ? pulls : pulls.slice(0, Math.ceil(pulls.length / nOpen)),
      })
    }
    await sleep(30)
  }
  return { rips, fetched, err: null, transient: false }
}

async function writeRips(rips: RipBuild[]): Promise<{ ripsWritten: number; pullsWritten: number }> {
  if (!rips.length) return { ripsWritten: 0, pullsWritten: 0 }
  // dedup by pack_nft_id and tx_hash (both uniquely indexed)
  const seenPack = new Set<string>(); const seenTx = new Set<string>()
  const distMap = new Map<string, string>()
  const packIds = rips.map((r) => r.pack_nft_id)
  // resolve dist from pack_purchases where known
  for (let i = 0; i < packIds.length; i += 500) {
    const chunk = packIds.slice(i, i + 500)
    const { data } = await supabase.from("pack_purchases").select("pack_nft_id, pack_dist_id")
      .eq("collection_id", COLL).in("pack_nft_id", chunk).not("pack_dist_id", "is", null)
    for (const row of data ?? []) distMap.set(String(row.pack_nft_id), String(row.pack_dist_id))
  }
  const ripRows: any[] = []; const pullRows: any[] = []
  for (const r of rips) {
    if (seenPack.has(r.pack_nft_id) || seenTx.has(r.tx_hash)) continue
    seenPack.add(r.pack_nft_id); seenTx.add(r.tx_hash)
    ripRows.push({
      collection_id: COLL, pack_nft_id: r.pack_nft_id, opener_address: r.opener,
      moments_pulled: r.pulls.length, tx_hash: r.tx_hash, block_height: r.block_height,
      sealed_at: r.sealed_at, dist_id: distMap.get(r.pack_nft_id) ?? null,
    })
    for (const m of r.pulls) pullRows.push({
      pack_nft_id: r.pack_nft_id, moment_nft_id: m, opener_address: r.opener,
      tx_hash: r.tx_hash, sealed_at: r.sealed_at,
    })
  }
  let ripsWritten = 0
  for (let i = 0; i < ripRows.length; i += 500) {
    const { data, error } = await supabase.from("pack_rips")
      .upsert(ripRows.slice(i, i + 500), { onConflict: "pack_nft_id", ignoreDuplicates: true }).select("id")
    if (error) throw new Error("pack_rips upsert: " + error.message)
    ripsWritten += data?.length ?? 0
  }
  let pullsWritten = 0
  for (let i = 0; i < pullRows.length; i += 500) {
    const { error } = await supabase.from("allday_pack_pull")
      .upsert(pullRows.slice(i, i + 500), { onConflict: "pack_nft_id,moment_nft_id", ignoreDuplicates: true })
    if (!error) pullsWritten += pullRows.slice(i, i + 500).length
  }
  return { ripsWritten, pullsWritten }
}

async function logRun(pipeline: string, startMs: number, ok: boolean, found: number, written: number, cb: number | null, ca: number | null, extra: any, error: string | null) {
  // duration_ms is a GENERATED column (finished_at - started_at) — never insert it.
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
  // Requested floor defaults to AllDay genesis; reachableFloor() clamps it up to
  // whatever is actually reachable (SPORK_FLOOR if the proxy is wired, else the
  // current-spork root — so a fn deployed WITHOUT the spork secret keeps today's
  // safe "stop at 137390146" behavior instead of 404-flapping).
  const requestedFloor = Number(url.searchParams.get("floor") ?? ALLDAY_GENESIS_FLOOR)
  const floor = reachableFloor(requestedFloor)
  const maxBlocks = Number(url.searchParams.get("blocks") ?? MAX_BLOCKS)
  const startMs = Date.now()
  const t = await tip()
  if (!t) return new Response(JSON.stringify({ error: "tip_unreachable" }), { status: 200, headers: { "content-type": "application/json" } })

  try {
    if (mode === "probe") {
      const end = t; const start = Math.max(floor, t - maxBlocks)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched } = await resolveOpens(opens.slice(0, 20), 20)
      return new Response(JSON.stringify({ mode, tip: t, start, end, queries, opens_found: opens.length, sample_resolved: rips.length, tx_fetched: fetched, scan_err: err,
        sample: rips.slice(0, 3).map((r) => ({ pack: r.pack_nft_id, opener: r.opener, pulls: r.pulls.length, tx: r.tx_hash })) }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "forward") {
      let cur = await getCursor(CUR_FWD)
      if (cur == null) { await setCursor(CUR_FWD, t); return new Response(JSON.stringify({ mode, init: true, cursor: t }), { headers: { "content-type": "application/json" } }) }
      if (cur >= t) { await logRun("allday-pack-opens-forward", startMs, true, 0, 0, cur, cur, { caught_up: true }, null); return new Response(JSON.stringify({ mode, caught_up: true, cursor: cur }), { headers: { "content-type": "application/json" } }) }
      const start = cur + 1; const end = Math.min(t, start + maxBlocks - 1)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched, err: rerr } = await resolveOpens(opens, MAX_TX)
      const { ripsWritten, pullsWritten } = await writeRips(rips)
      const after = err || rerr ? start - 1 : end // don't advance past a failed window
      if (after >= start) await setCursor(CUR_FWD, after)
      const fatal = (err || rerr) && opens.length === 0
      await logRun("allday-pack-opens-forward", startMs, !fatal, opens.length, ripsWritten, cur, after, { queries, tx_fetched: fetched, pulls_written: pullsWritten, scan_err: err, resolve_err: rerr, start, end }, fatal ? (err || rerr) : null)
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, pulls_written: pullsWritten, cursor_after: after, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "backfill") {
      let cur = await getCursor(CUR_BACK)
      if (cur == null) { await setCursor(CUR_BACK, t); return new Response(JSON.stringify({ mode, init: true, cursor: t }), { headers: { "content-type": "application/json" } }) }
      if (cur <= floor) { await logRun("allday-pack-opens-backfill", startMs, true, 0, 0, cur, cur, { done: true, floor, spork_available: SPORK_AVAILABLE }, null); return new Response(JSON.stringify({ mode, done: true, cursor: cur, floor, spork_available: SPORK_AVAILABLE }), { headers: { "content-type": "application/json" } }) }
      const end = cur - 1
      // Clamp the tick window down to `floor` AND up to the floor of end's spork,
      // so [start,end] never crosses a spork boundary / CURRENT_SPORK_MIN — the
      // spork-proxy events endpoint rejects cross-boundary ranges. The backfill
      // just takes one extra tick at each boundary.
      let start = Math.max(floor, end - maxBlocks + 1)
      start = Math.max(start, sporkFloorOf(end))
      const { opens, queries, err, transient } = await scanOpens(start, end)
      const { rips, fetched, err: rerr, transient: rtransient } = await resolveOpens(opens, MAX_TX)
      const { ripsWritten, pullsWritten } = await writeRips(rips)
      const anyTransient = (!!err && transient) || (!!rerr && rtransient)
      const skippedPermanent = (!!err || !!rerr) && !anyTransient
      // TRANSIENT error -> hold at `cur`, retry the same window next tick.
      // Success OR PERMANENT error -> advance DOWN to `start`. Advancing past a
      // permanently-dead window (pruned/below-floor 404) is the fix for the
      // pre-2026-07-11 wedge where every error held the cursor and the tick
      // retried the identical range forever.
      const after = anyTransient ? cur : start
      if (after < cur) await setCursor(CUR_BACK, after)
      const ok = !anyTransient
      await logRun("allday-pack-opens-backfill", startMs, ok, opens.length, ripsWritten, cur, after,
        { queries, tx_fetched: fetched, pulls_written: pullsWritten, scan_err: err, resolve_err: rerr,
          transient: anyTransient, skipped_permanent: skippedPermanent, start, end, floor,
          spork_available: SPORK_AVAILABLE, routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" },
        ok ? null : (err || rerr))
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, pulls_written: pullsWritten, cursor_after: after, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr, transient: anyTransient, skipped_permanent: skippedPermanent, spork_available: SPORK_AVAILABLE, routed: end < CURRENT_SPORK_MIN ? "spork" : "rest" }), { headers: { "content-type": "application/json" } })
    }

    return new Response(JSON.stringify({ error: "bad_mode", mode }), { status: 400, headers: { "content-type": "application/json" } })
  } catch (e) {
    await logRun(`allday-pack-opens-${mode}`, startMs, false, 0, 0, null, null, { exception: true }, e instanceof Error ? e.message : String(e))
    return new Response(JSON.stringify({ error: "exception", message: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { "content-type": "application/json" } })
  }
})
