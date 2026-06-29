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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const GATE = "rpc_pls_8x2f9k3m_alldayopen"
const REST = "https://rest-mainnet.onflow.org"
const COLL = "dee28451-5d62-409e-a1ad-a83f763ac070"
const OPENED = "A.e4cf4bdc1751c65d.PackNFT.Opened"
const DEPOSIT = "A.e4cf4bdc1751c65d.AllDay.Deposit"
const CUR_FWD = "allday_pack_opens_forward"
const CUR_BACK = "allday_pack_opens_backfill"
// AllDay PackNFT predates this, but mainnet pack OPENS don't occur below it.
// Conservative floor (~mid-2022); overridable via ?floor=.
const DEFAULT_FLOOR = 30000000
const EVENT_RANGE = 250          // Flow REST hard cap per /v1/events query
const MAX_BLOCKS = 25000         // ~100 event queries / run (gentle)
const MAX_TX = 180               // cap tx_results fetches / run (opens are sparse)

const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function j(url: string, tries = 3): Promise<{ ok: true; data: any } | { ok: false; status: number }> {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) })
      if (r.ok) return { ok: true, data: await r.json() }
      if ((r.status === 429 || r.status >= 500) && a < tries) { await sleep(400 * a); continue }
      return { ok: false, status: r.status }
    } catch { if (a < tries) { await sleep(400 * a); continue } return { ok: false, status: 0 } }
  }
  return { ok: false, status: 0 }
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
async function scanOpens(start: number, end: number): Promise<{ opens: Open[]; queries: number; err: string | null }> {
  const opens: Open[] = []
  let queries = 0
  for (let lo = start; lo <= end; lo += EVENT_RANGE) {
    const hi = Math.min(end, lo + EVENT_RANGE - 1)
    queries++
    const res = await j(`${REST}/v1/events?type=${encodeURIComponent(OPENED)}&start_height=${lo}&end_height=${hi}`)
    if (!res.ok) return { opens, queries, err: `events ${lo}-${hi} status ${res.status}` }
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
  return { opens, queries, err: null }
}

// For a set of open txs, fetch tx_results and derive opener + pulled moments.
type RipBuild = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null; opener: string; pulls: string[] }
async function resolveOpens(opens: Open[], budget: number): Promise<{ rips: RipBuild[]; fetched: number; err: string | null }> {
  // group by tx (a tx normally opens exactly one pack)
  const byTx = new Map<string, Open[]>()
  for (const o of opens) { const a = byTx.get(o.tx_hash) ?? []; a.push(o); byTx.set(o.tx_hash, a) }
  const rips: RipBuild[] = []
  let fetched = 0
  for (const [txh, group] of byTx) {
    if (fetched >= budget) break
    fetched++
    const tr = await j(`${REST}/v1/transaction_results/${txh}`)
    if (!tr.ok) { if (tr.status === 0) return { rips, fetched, err: `tx ${txh} unreachable` }; continue }
    // collect AllDay.Deposit (moment id + recipient)
    const deposits: { id: string; to: string }[] = []
    for (const e of tr.data?.events ?? []) {
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
  return { rips, fetched, err: null }
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
  const floor = Number(url.searchParams.get("floor") ?? DEFAULT_FLOOR)
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
      if (cur <= floor) { await logRun("allday-pack-opens-backfill", startMs, true, 0, 0, cur, cur, { done: true, floor }, null); return new Response(JSON.stringify({ mode, done: true, cursor: cur, floor }), { headers: { "content-type": "application/json" } }) }
      const end = cur - 1; const start = Math.max(floor, end - maxBlocks + 1)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched, err: rerr } = await resolveOpens(opens, MAX_TX)
      const { ripsWritten, pullsWritten } = await writeRips(rips)
      const after = err || rerr ? end + 1 : start // on failure, don't advance past the window
      if (after <= cur) await setCursor(CUR_BACK, after)
      const fatal = (err || rerr) && opens.length === 0
      await logRun("allday-pack-opens-backfill", startMs, !fatal, opens.length, ripsWritten, cur, after, { queries, tx_fetched: fetched, pulls_written: pullsWritten, scan_err: err, resolve_err: rerr, start, end }, fatal ? (err || rerr) : null)
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, pulls_written: pullsWritten, cursor_after: after, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr }), { headers: { "content-type": "application/json" } })
    }

    return new Response(JSON.stringify({ error: "bad_mode", mode }), { status: 400, headers: { "content-type": "application/json" } })
  } catch (e) {
    await logRun(`allday-pack-opens-${mode}`, startMs, false, 0, 0, null, null, { exception: true }, e instanceof Error ? e.message : String(e))
    return new Response(JSON.stringify({ error: "exception", message: e instanceof Error ? e.message : String(e) }), { status: 200, headers: { "content-type": "application/json" } })
  }
})
