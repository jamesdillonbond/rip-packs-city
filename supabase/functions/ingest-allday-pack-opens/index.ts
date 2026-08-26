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
// DEEP-HISTORY (2026-07-11): the backfill routes sub-current-spork windows
// through the spork-proxy worker (workers/spork-proxy). See "Spork routing"
// below.
//
// ⚠ REACH REVISED 2026-08-07 — AllDay genesis is NO LONGER reachable. This
// comment used to promise "can now reach AllDay genesis (~35–40M)". The
// mainnet17–23 access nodes have since been decommissioned, so the true floor
// is the **mainnet24 root = 65,264,619 (2023-11-08)**. AllDay pack opens from
// launch through 2023-11-08 are permanently unrecoverable via public
// infrastructure — an explicit coverage limit, not a bug and not fixable here.
// See the SPORK_FLOOR comment for the measurement. This is AUTO-GATED
// on SPORK_PROXY_URL + SPORK_PROXY_SECRET being present in the fn env: unset =>
// the floor stays at the current-spork root, no flapping; set => the floor
// drops to SPORK_FLOOR (65,264,619 — NOT AllDay genesis, see above) and
// historical windows route to the spork nodes. Forward/probe paths are
// unchanged (they only ever touch >= CURRENT_SPORK_MIN heights, which always
// use rest-mainnet).
import { createClient } from "@supabase/supabase-js"

// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set ALLDAY_PACK_OPENS_GATE_KEY=<new-random>
const GATE = Deno.env.get("ALLDAY_PACK_OPENS_GATE_KEY") ?? ""
// Transitional SECOND key, read from its own secret — never a literal (this repo is PUBLIC).
// During a key rotation, set ALLDAY_PACK_OPENS_GATE_KEY_OLD to the OUTGOING key: both are then accepted, so the
// pg_cron ?key= values can be repointed one job at a time instead of atomically. Finish the
// rotation by DELETING the _OLD secret — no redeploy needed. Both unset ⇒ still fails CLOSED.
const GATE_OLD = Deno.env.get("ALLDAY_PACK_OPENS_GATE_KEY_OLD") ?? ""
function gateKeyOk(k: string | null): boolean {
  return !!k && ((GATE !== "" && k === GATE) || (GATE_OLD !== "" && k === GATE_OLD))
}
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
//   SPORK_FLOOR       — mainnet24 root (2023-11-08). The public sporks bottom
//                       out here; mainnet23 and older are decommissioned, so
//                       nothing below SPORK_FLOOR is recoverable by ANY path.
//   ALLDAY_GENESIS_FLOOR — the backfill's HISTORICAL INTENT (AllDay's first
//                       PackNFT.Opened is ~35–40M). It is now BELOW SPORK_FLOOR
//                       and is therefore clamped up by reachableFloor(); it is
//                       kept only to document what the walk was aiming at.
//                       Overridable via ?floor=, which is clamped the same way.
//   SPORK_MAX_HEIGHTS — per-spork upper block (next spork root − 1), ascending;
//                       must match workers/spork-proxy SPORKS. A spork-proxy
//                       events query may not cross a spork boundary, so each
//                       backfill tick is clamped to a single spork below.
const CURRENT_SPORK_MIN = 137390146
// SPORK_FLOOR RAISED 27,341,470 -> 65,264,619 on 2026-08-07, mirroring the same
// raise in ingest-topshot-pack-opens-history (f4d284c7). 65,264,619 is the
// **mainnet24 root**. The mainnet17–23 access nodes are DECOMMISSIONED, so
// nothing below this is obtainable from Flow's public infrastructure. Measured
// three ways (spork infrastructure is collection-agnostic — same proxy, same
// origin hosts, event_type is just a query param — so the Top Shot measurement
// applies verbatim here):
//   1. Every spork band <= 65,264,618 returns Cloudflare 522 through
//      spork-proxy; every band above returns 200. A transient outage does not
//      fail precisely at a protocol boundary.
//   2. Probing the origins DIRECTLY (Cloudflare removed): mainnet22/23 never
//      answer, mainnet24/25 return 200 from the same box and port.
//   3. DNS still resolves for mainnet21/22/23 while TCP connect black-holes —
//      retired hosts with uncleaned DNS records.
// The Archive Node is not a fallback (single-spork limit).
//
// WHY PRE-EMPTIVELY, while the walk is still far above the floor: this backfill
// descends ~850,000 blocks / 6h (34/34 ok, measured 2026-08-07 over the
// trailing 6h from cursor 89,465,659). At that rate it reaches 65,264,619 in
// ~7.1 days, i.e. ~2026-08-14 — and would then grind against dead hosts on a
// 15-min cron, exactly the 68-runs/0-ok retry loop the Top Shot twin just ate,
// paging as cursor_stalled and burning multi-day failing streaks before anyone
// reconnected it to this cause. Nothing REACHABLE is abandoned: the walk still
// covers everything from here down to the floor; only the already-unreachable
// sub-65.26M tail is dropped, and it takes the existing `cur <= floor` branch
// (ok=true, done:true, no scan, cursor NOT mutated — so this stays reversible).
//
// SPORK_MAX_HEIGHTS deliberately untrimmed: the SPORK_FLOOR seed in
// sporkFloorOf() only matters for a height in the FIRST band (<= 31,735,954),
// which is now unreachable, so trimming would change no reachable behaviour.
const SPORK_FLOOR = 65264619
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

// ── Per-attempt abort budgets ───────────────────────────────────────────────
//
// ⚠ THESE WERE ONE HARDCODED `15000` SHARED BY FIVE CALL SITES, and that is a
// trap rather than a tidiness issue. Only TWO of the five route to the spork
// proxy (`eventsFetch` / `txFetch`); the other three — including `tip()` — go to
// rest-mainnet and are the HEALTHY lane (jobid 20 `forward`, p50 2.6 s). Raising
// the shared literal to fix the spork lane would also raise it for the healthy
// one, which carries the SAME 90 000 ms `net.http_get` budget, for no benefit.
//
// ⚠ THE OPEN BUG THIS EXISTS FOR (measured 2026-08-21, not yet fixed): the spork
// caller aborts at 15 s while `workers/spork-proxy` allows ITSELF
// `REQUEST_TIMEOUT_MS = 25_000`, so the caller quits 10 s before the worker may
// answer. `status 0` on 40 of 42 backfill runs / 72h is that abort — a
// worker-side timeout would read `504`, which is what proves which side gives up.
//
// ⚠ RAISING `SPORK_TIMEOUT_MS` MEANS LOWERING `SPORK_TRIES`. The abort multiplies
// by the retry count, and the whole tick has to answer inside pg_net's 90 s or no
// response body is recorded at all — which would blind `net._http_response`, the
// only instrument that diagnosed this. The arithmetic is asserted in
// __tests__/edge-allday-pack-opens-timeout-budget.test.ts, so a value that does
// not fit reddens CI instead of shipping:
//
//     28 s x 2 tries = 56.4 s   ✅ fits, and each attempt outlasts the worker
//     28 s x 3 tries = 85.2 s   ⚠ fits, but leaves 4.8 s for the rest of the tick
//     30 s x 3 tries = 91.2 s   ❌ exceeds pg_net's 90 s — no body ever recorded
//
// Values below are UNCHANGED from the shared literal: this commit is purely the
// scoping, so the number itself stays a decision for the gate-key rotation window
// (the only window in which this function can be deployed at all).
const REST_TIMEOUT_MS = 15_000
const SPORK_TIMEOUT_MS = 15_000
const SPORK_TRIES = 3

async function j(url: string, tries = 3, headers: Record<string, string> = {}, timeoutMs = REST_TIMEOUT_MS): Promise<{ ok: true; data: any } | { ok: false; status: number }> {
  for (let a = 1; a <= tries; a++) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) })
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
    return j(`${SPORK_URL}/?event_type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`, SPORK_TRIES, sporkHeaders, SPORK_TIMEOUT_MS)
  }
  return j(`${REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${lo}&end_height=${hi}`)
}
// Transaction result, routed by the open's block height. rest-mainnet exposes
// /v1/transaction_results/{tx} (events at top level); the spork-proxy returns
// /v1/transactions/{tx}?expand=result (events under .result.events). Callers
// read events via txEvents() to normalize the two shapes.
function txFetch(txh: string, block: number) {
  if (block < CURRENT_SPORK_MIN && SPORK_AVAILABLE) {
    return j(`${SPORK_URL}/?tx=${txh}`, SPORK_TRIES, sporkHeaders, SPORK_TIMEOUT_MS)
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
// A cursor READ FAILURE must never be confused with "cursor absent". The old
// body dropped `error` and returned null on both, so a single transient
// PostgREST blip made the caller take the `cur == null` init branch and
// RESET the cursor to tip — silently destroying walk progress. That fired on
// 2026-07-25: the backfill had reached block 127,740,659, was reset to
// 159,183,789, and has been re-walking ~31.4M already-ingested blocks since
// (~18.4k Flow REST calls/day for ~93 genuinely-new rows). Returning a
// discriminated result lets the caller abort the tick instead of re-seeding.
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
// [start,end] must sit within a single spork (caller guarantees) so eventsFetch
// routes the whole scan to one node. On the first failed query it returns the
// error + whether it was transient (retry) or permanent (skip the window).
//
// SCAN DIRECTION MUST MATCH THE CALLER'S CURSOR DIRECTION. This fn serves two
// walkers going opposite ways, and the direction is what makes partial progress
// checkpointable:
//   backfill (walks DOWN) -> "desc". A mid-window failure then leaves a complete
//     SUFFIX [scannedFloor, end], and the tx budget leaves the LOWEST opens
//     unresolved — so the lowest RESOLVED block is exactly the safe checkpoint.
//   forward (walks UP) -> "asc" (the historical behaviour; unchanged). A desc
//     scan here would invert which opens the tx budget drops.
// Getting this backwards is silent data loss, not an error: with the wrong
// direction NO cursor value is safe, because the unscanned hole sits on the
// side the cursor is about to claim.
// `scannedFloor`/`scannedCeil` = the bound CONFIRMED scanned in that direction.
type ScanDir = "asc" | "desc"
async function scanOpens(start: number, end: number, dir: ScanDir = "asc"): Promise<{ opens: Open[]; queries: number; err: string | null; transient: boolean; scannedFloor: number; scannedCeil: number }> {
  const opens: Open[] = []
  let queries = 0
  const take = (res: any) => {
    for (const blk of res.data ?? []) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp ?? null
      for (const ev of blk.events ?? []) {
        const p = dec(ev.payload)
        const packId = prim(field(p, "id"))
        if (packId != null) opens.push({ pack_nft_id: String(packId), tx_hash: ev.transaction_id, block_height: bh, sealed_at: bts })
      }
    }
  }
  if (dir === "desc") {
    let hi = end
    while (hi >= start) {
      const lo = Math.max(start, hi - EVENT_RANGE + 1)
      queries++
      const res = await eventsFetch(OPENED, lo, hi)
      if (!res.ok) return { opens, queries, err: `events ${lo}-${hi} status ${res.status}`, transient: isTransient(res.status), scannedFloor: hi + 1, scannedCeil: end }
      take(res)
      hi = lo - 1
      await sleep(30)
    }
    return { opens, queries, err: null, transient: false, scannedFloor: start, scannedCeil: end }
  }
  for (let lo = start; lo <= end; lo += EVENT_RANGE) {
    const hi = Math.min(end, lo + EVENT_RANGE - 1)
    queries++
    const res = await eventsFetch(OPENED, lo, hi)
    if (!res.ok) return { opens, queries, err: `events ${lo}-${hi} status ${res.status}`, transient: isTransient(res.status), scannedFloor: start, scannedCeil: lo - 1 }
    take(res)
    await sleep(30)
  }
  return { opens, queries, err: null, transient: false, scannedFloor: start, scannedCeil: end }
}

// For a set of open txs, fetch tx_results and derive opener + pulled moments.
type RipBuild = { pack_nft_id: string; tx_hash: string; block_height: number; sealed_at: string | null; opener: string; pulls: string[] }
// `resolvedFloor` = lowest block whose opens are fully resolved (null if none);
// `exhausted` = stopped early with opens still unresolved (tx budget, or a
// transient tx read failure). The caller must not advance the cursor past
// unresolved opens: scanning a block is NOT the same as having written its rips.
// Before 2026-08-01 a budget stop still advanced the full window, silently
// dropping every open past the 180-tx cutoff — 16 of 143 runs in 24h hit it.
async function resolveOpens(opens: Open[], budget: number): Promise<{ rips: RipBuild[]; fetched: number; err: string | null; transient: boolean; resolvedFloor: number | null; exhausted: boolean }> {
  // group by tx (a tx normally opens exactly one pack)
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
    // Route by the open's block: historical txs are pruned from rest-mainnet and
    // must go through the spork-proxy (?tx=). A transient failure aborts the
    // batch (caller retries); a permanent one skips just this tx (the other
    // opens in the window still resolve).
    const tr = await txFetch(txh, group[0].block_height)
    if (!tr.ok) { if (isTransient(tr.status)) return { rips, fetched, err: `tx ${txh} status ${tr.status}`, transient: true, resolvedFloor, exhausted: true }; note(group[0].block_height); continue }
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
    note(group[0].block_height)
    await sleep(30)
  }
  return { rips, fetched, err: null, transient: false, resolvedFloor, exhausted: false }
}

type WriteStats = { ripsWritten: number; pullsWritten: number; ripsAlreadyPresent: number; pullsAlreadyPresent: number }
async function writeRips(rips: RipBuild[]): Promise<WriteStats> {
  if (!rips.length) return { ripsWritten: 0, pullsWritten: 0, ripsAlreadyPresent: 0, pullsAlreadyPresent: 0 }
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
  // Which of these are ALREADY on file? Measured up front, because the
  // `.upsert(..., ignoreDuplicates).select()` return value cannot be trusted as
  // an insert count: on 2026-07-27 the 03:26 tick reported pulls_written 102
  // for a window whose 102 pull rows were all created 2026-06-30, and table
  // growth that hour was 0. Reading the keys first makes both the write count
  // and the "already present" count exact, and makes a 0 self-explaining
  // (nothing new HERE) rather than ambiguous (found nothing / wrote nothing).
  const knownPacks = new Set<string>()
  const ripIds = ripRows.map((r) => r.pack_nft_id)
  for (let i = 0; i < ripIds.length; i += 500) {
    const { data } = await supabase.from("pack_rips").select("pack_nft_id")
      .eq("collection_id", COLL).in("pack_nft_id", ripIds.slice(i, i + 500))
    for (const row of data ?? []) knownPacks.add(String(row.pack_nft_id))
  }
  const knownPulls = new Set<string>()
  for (let i = 0; i < ripIds.length; i += 200) {
    // Paginate: 200 packs x ~5 moments can exceed PostgREST's 1000-row cap, and
    // a bare .select() clamps there silently — which would fake "not present"
    // and re-inflate the very counter this block exists to make honest.
    const chunk = ripIds.slice(i, i + 200)
    for (let off = 0; ; off += 1000) {
      const { data } = await supabase.from("allday_pack_pull").select("pack_nft_id, moment_nft_id")
        .in("pack_nft_id", chunk).order("pack_nft_id").order("moment_nft_id").range(off, off + 999)
      for (const row of data ?? []) knownPulls.add(`${row.pack_nft_id}:${row.moment_nft_id}`)
      if ((data?.length ?? 0) < 1000) break
    }
  }
  const ripsAlreadyPresent = ripRows.filter((r) => knownPacks.has(r.pack_nft_id)).length
  const pullsAlreadyPresent = pullRows.filter((p) => knownPulls.has(`${p.pack_nft_id}:${p.moment_nft_id}`)).length

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
    if (!error) pullsWritten += pullRows.slice(i, i + 500).filter((p) => !knownPulls.has(`${p.pack_nft_id}:${p.moment_nft_id}`)).length
  }
  return { ripsWritten, pullsWritten, ripsAlreadyPresent, pullsAlreadyPresent }
}

// ⚠ THE TELEMETRY WRITE MUST CHECK ITS OWN RETURNED ERROR (fixed here).
//
// This is the ONE writer for both `allday-pack-opens-forward` and
// `allday-pack-opens-backfill`, and it used to be a bare
// `await supabase.from("pipeline_runs").insert({...})`. supabase-js RETURNS
// errors rather than throwing, so the returned `error` was the only evidence a
// run row had failed to land — and nothing read it. A failed telemetry write
// was therefore INDISTINGUISHABLE from a successful one at every level: the
// walker carried on, the fn returned 200, and `pipeline_runs` simply had no row.
// That is the "a failed read must not render as an answer" class pointed at the
// instrument instead of the surface: the absence of a row reads to every
// downstream consumer (`detect_stalled_pipelines`, `v_pipeline_failure_rates`,
// `v_pack_pipeline_health`) as "the pipeline did not run", which is a different
// and much louder claim than "we could not record that it did".
//
// ⚠ THIS IS NOT THE CAUSE OF THE `allday-pack-opens-backfill` SILENCE, and must
// not be filed as its fix. The IDENTICAL call — same function, same client, same
// table — writes ~46 `allday-pack-opens-forward` rows a day, so the writer
// demonstrably works and the backfill's missing rows have a different cause
// upstream of here. This is an independent defect: it makes a whole class of
// telemetry failure unfalsifiable, which is worth fixing on its own, but closing
// the backfill investigation on it would be a wrong attribution.
//
// ⚠ NEVER THROWS, and never rejects. A telemetry failure must not become a
// pipeline failure: these calls sit on the walker's own return paths (including
// the `cursor_read_failed` aborts), so a throw here would replace a recorded
// failure with an unrecorded crash — strictly worse than the defect being fixed.
// Both shapes are handled: the RETURNED error (the supabase-js path, the actual
// bug) and a THROW (transport/DNS, which the client does propagate). Mirrors
// `writeInvocationHeartbeat` in lib/pipeline/heartbeat.ts, which reached the
// same contract for the same reason.
async function logRun(pipeline: string, startMs: number, ok: boolean, found: number, written: number, cb: number | null, ca: number | null, extra: any, error: string | null) {
  // duration_ms is a GENERATED column (finished_at - started_at) — never insert it.
  try {
    const { error: logErr } = await supabase.from("pipeline_runs").insert({
      pipeline, started_at: new Date(startMs).toISOString(),
      rows_found: found, rows_written: written, cursor_before: cb != null ? String(cb) : null,
      cursor_after: ca != null ? String(ca) : null, ok, error, extra,
    })
    // Distinctive prefix so the miss is greppable in the fn logs without
    // knowing which pipeline was writing — the operator searching for "why is
    // there no row" has the pipeline name in hand but not this file.
    if (logErr) console.error(`[pipeline_runs-insert-failed] ${pipeline}: ${logErr.message}`)
  } catch (e) {
    console.error(`[pipeline_runs-insert-threw] ${pipeline}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  if (!gateKeyOk(url.searchParams.get("key"))) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
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
  if (!t) {
    // ⚠ This return sits OUTSIDE the try, so it never reached the catch's
    // logRun. Before 2026-08-13 an unreachable tip produced: HTTP 200 (not a
    // 4xx/5xx, so invisible to check_edge_fn_http_failures), NO pipeline_runs
    // row (so invisible to failure_rate), and cron.job_run_details "succeeded"
    // (dispatch worked). Every instrument in the estate read clean while the
    // walk did nothing — the exact shape that made the 2026-08-11 gate-key
    // outage undetectable for a day. A failure must leave a trace somewhere.
    await logRun(`allday-pack-opens-${mode}`, startMs, false, 0, 0, null, null, { tip_unreachable: true }, "tip_unreachable")
    return new Response(JSON.stringify({ error: "tip_unreachable" }), { status: 200, headers: { "content-type": "application/json" } })
  }

  try {
    if (mode === "probe") {
      const end = t; const start = Math.max(floor, t - maxBlocks)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched } = await resolveOpens(opens.slice(0, 20), 20)
      return new Response(JSON.stringify({ mode, tip: t, start, end, queries, opens_found: opens.length, sample_resolved: rips.length, tx_fetched: fetched, scan_err: err,
        sample: rips.slice(0, 3).map((r) => ({ pack: r.pack_nft_id, opener: r.opener, pulls: r.pulls.length, tx: r.tx_hash })) }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "forward") {
      const curRead = await getCursor(CUR_FWD)
      if (!curRead.ok) { await logRun("allday-pack-opens-forward", startMs, false, 0, 0, null, null, { cursor_read_failed: true }, curRead.error); return new Response(JSON.stringify({ mode, error: "cursor_read_failed", detail: curRead.error }), { headers: { "content-type": "application/json" } }) }
      const cur = curRead.value
      if (cur == null) { await setCursor(CUR_FWD, t); return new Response(JSON.stringify({ mode, init: true, cursor: t }), { headers: { "content-type": "application/json" } }) }
      if (cur >= t) { await logRun("allday-pack-opens-forward", startMs, true, 0, 0, cur, cur, { caught_up: true }, null); return new Response(JSON.stringify({ mode, caught_up: true, cursor: cur }), { headers: { "content-type": "application/json" } }) }
      const start = cur + 1; const end = Math.min(t, start + maxBlocks - 1)
      const { opens, queries, err } = await scanOpens(start, end)
      const { rips, fetched, err: rerr } = await resolveOpens(opens, MAX_TX)
      const { ripsWritten, pullsWritten, ripsAlreadyPresent, pullsAlreadyPresent } = await writeRips(rips)
      const after = err || rerr ? start - 1 : end // don't advance past a failed window
      if (after >= start) await setCursor(CUR_FWD, after)
      const fatal = (err || rerr) && opens.length === 0
      await logRun("allday-pack-opens-forward", startMs, !fatal, opens.length, ripsWritten + pullsWritten, cur, after, { queries, tx_fetched: fetched, rips_written: ripsWritten, pulls_written: pullsWritten, rips_already_present: ripsAlreadyPresent, pulls_already_present: pullsAlreadyPresent, scan_err: err, resolve_err: rerr, start, end }, fatal ? (err || rerr) : null)
      return new Response(JSON.stringify({ mode, start, end, opens: opens.length, rips_written: ripsWritten, pulls_written: pullsWritten, cursor_after: after, queries, tx_fetched: fetched, scan_err: err, resolve_err: rerr }), { headers: { "content-type": "application/json" } })
    }

    if (mode === "backfill") {
      const curRead = await getCursor(CUR_BACK)
      if (!curRead.ok) { await logRun("allday-pack-opens-backfill", startMs, false, 0, 0, null, null, { cursor_read_failed: true }, curRead.error); return new Response(JSON.stringify({ mode, error: "cursor_read_failed", detail: curRead.error }), { headers: { "content-type": "application/json" } }) }
      const cur = curRead.value
      if (cur == null) { await setCursor(CUR_BACK, t); return new Response(JSON.stringify({ mode, init: true, cursor: t }), { headers: { "content-type": "application/json" } }) }
      if (cur <= floor) { await logRun("allday-pack-opens-backfill", startMs, true, 0, 0, cur, cur, { done: true, floor, spork_available: SPORK_AVAILABLE }, null); return new Response(JSON.stringify({ mode, done: true, cursor: cur, floor, spork_available: SPORK_AVAILABLE }), { headers: { "content-type": "application/json" } }) }
      const end = cur - 1
      // Clamp the tick window down to `floor` AND up to the floor of end's spork,
      // so [start,end] never crosses a spork boundary / CURRENT_SPORK_MIN — the
      // spork-proxy events endpoint rejects cross-boundary ranges. The backfill
      // just takes one extra tick at each boundary.
      let start = Math.max(floor, end - maxBlocks + 1)
      start = Math.max(start, sporkFloorOf(end))
      const { opens, queries, err, transient, scannedFloor } = await scanOpens(start, end, "desc")
      const { rips, fetched, err: rerr, transient: rtransient, resolvedFloor, exhausted } = await resolveOpens(opens, MAX_TX)
      const { ripsWritten, pullsWritten, ripsAlreadyPresent, pullsAlreadyPresent } = await writeRips(rips)
      const anyTransient = (!!err && transient) || (!!rerr && rtransient)
      const skippedPermanent = (!!err || !!rerr) && !anyTransient
      // Advance to the deepest point actually SCANNED and (where opens were
      // present) RESOLVED. Supersedes `anyTransient ? cur : start`, which had two
      // failure modes: it discarded a whole ~100-query window on one flaky-node
      // failure (never advancing), and on a tx-budget stop it advanced the FULL
      // window over opens it never wrote (16 of 143 runs in 24h on 2026-08-01).
      // Scanning a block is not the same as having written its rips.
      let after = scannedFloor
      if (exhausted) after = Math.max(after, resolvedFloor ?? cur)
      after = Math.min(after, cur)   // never walk back up
      after = Math.max(after, floor) // never below the reachable floor
      if (after < cur) await setCursor(CUR_BACK, after)
      const progressed = after < cur
      // A checkpointed run that ADVANCED did its job even if a later chunk
      // failed (error preserved in extra.scan_err + extra.partial); only a
      // zero-progress run is a real wedge and stays ok=false.
      const ok = progressed || !(!!err || !!rerr)
      // rows_written counts rips AND pulls. Reporting only rips made this
      // pipeline look dead: over 3 days to 2026-07-27 it logged rows_written 0
      // on 425 runs while allday_pack_pull actually grew by 61,179 rows.
      await logRun("allday-pack-opens-backfill", startMs, ok, opens.length, ripsWritten + pullsWritten, cur, after,
        { queries, tx_fetched: fetched, rips_written: ripsWritten, pulls_written: pullsWritten,
          rips_already_present: ripsAlreadyPresent, pulls_already_present: pullsAlreadyPresent,
          scan_err: err, resolve_err: rerr,
          partial: (!!err || !!rerr) && progressed, progress_blocks: cur - after,
          scanned_floor: scannedFloor, resolved_floor: resolvedFloor, resolve_exhausted: exhausted,
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
