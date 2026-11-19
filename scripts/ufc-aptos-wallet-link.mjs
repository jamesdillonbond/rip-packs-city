#!/usr/bin/env node
// scripts/ufc-aptos-wallet-link.mjs — UFC Strike: recover each collector's Flow (Dapper) -> Aptos wallet link.
//
// Why: UFC Strike migrated Flow -> Aptos by burn-and-mint. The user's Dapper account burns a batch of
// UFC_NFT moments on Flow (tx args are only the NFT ids), then ~1 minute later UFC's issuer mints the same
// moments (same edition + serial) on Aptos to the user's Aptos wallet (issuer::mint_for). Neither chain stores
// the pairing, but the burn -> mint sequence recovers it. RPC can then resolve a user's UFC Aptos holdings from
// the Dapper address they already give us. Finding: claude/ufc-aptos-wallet-link-finding-2026-11-15.md.
//
// Per run:
//   1. Lists the Aptos issuer::mint_for txs NEWER than ufc_aptos_mint_txs' max version (Aptos indexer) into that
//      table (2026-11-19; it used to re-list all ~10k every run), then works on stored mints not yet in
//      ufc_aptos_migration_matches.
//   2. For each new one: reads its serials from the tx, finds the Flow height at mint time on the right spork,
//      scans UFC_NFT.NFTDestroyed for ~12 min before (widened to ~40 min if nothing), groups burns by Flow tx,
//      picks the latest burn of exactly n moments (else the latest larger burn = one burn split over several
//      Aptos mints), and reads the burner from UFC_NFT.Withdraw.
//   3. Upserts ufc_aptos_migration_matches (match = count_exact | count_superset | none), then
//      refresh_ufc_aptos_wallet_links() rebuilds ufc_aptos_wallet_links.
//   Batches whose Flow spork node cannot be reached are skipped (not written) and retried next run.
//   'none' rows are mostly UFC's 20-moment Aptos pack-mint batches, which have no Flow burn.
//
// Flow history: mainnet28 (from 2025-12-29) is on the public REST node. mainnet26/27 hold the Aug–Dec 2025
// migration wave; their spork access nodes answer REST on :8070 (override with FLOW_REST_MAINNET26/27).
// Measured 2026-11-15 on mainnet28: 2,703 mint txs -> 1,254 matched, 1,068 Flow burns, 1,066 to a single Aptos
// wallet, 963 with minted total == burn size; serial spot check 21/22 exact-count batches fully confirmed.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; APTOS_API_KEY recommended.
// Usage: node scripts/ufc-aptos-wallet-link.mjs [--apply] [--budget-sec 900] [--concurrency 6] [--spork mainnet28]
// Revert: DROP the two tables + refresh function (see migration audit_20261116_ufc_aptos_migration_matches).

import { createClient } from "@supabase/supabase-js"

const ISSUER_FN = "0x80f686c7bba12a0fce839ff160cb69774715497288996b861528727ccd256cdb::issuer::mint_for"
const UFC = "A.329feb3ab062d289.UFC_NFT"
const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const APT = ["https://api.mainnet.aptoslabs.com/v1", "https://archive.mainnet.aptoslabs.com/v1"]
const SPORKS = [ // https://github.com/onflow/flow/blob/master/sporks.json
  { name: "mainnet26", from: "2024-09-25T15:00:00Z", root: 88226267, rest: process.env.FLOW_REST_MAINNET26 || "http://access-001.mainnet26.nodes.onflow.org:8070/v1" },
  { name: "mainnet27", from: "2025-10-22T13:00:00Z", root: 130290659, rest: process.env.FLOW_REST_MAINNET27 || "http://access-001.mainnet27.nodes.onflow.org:8070/v1" },
  { name: "mainnet28", from: "2025-12-29T02:45:00Z", root: 137390146, rest: process.env.FLOW_REST_MAINNET28 || "https://rest-mainnet.onflow.org/v1" },
]
for (let i = 0; i < SPORKS.length; i++) SPORKS[i].end = SPORKS[i + 1] ? SPORKS[i + 1].root - 1 : null

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
// The budget bounds the MATCHING loop and starts when it starts. Listing every Aptos mint first takes
// 4–11 min on the hosted runner (11-16: 4 min at 04:26Z, 11 min at 17:25Z). When the clock also covered
// that listing, the 17:25Z run spent the whole budget there and matched nothing. The listing has its own
// cap (--enum-budget-sec) and fails the run, rather than quietly leaving no time to do the work.
const BUDGET_MS = Number(arg("--budget-sec", 900)) * 1000
const ENUM_BUDGET_MS = Number(arg("--enum-budget-sec", 720)) * 1000
const CONC = Number(arg("--concurrency", 6))
const ONLY_SPORK = arg("--spork", null)
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const aptHeaders = { "content-type": "application/json", ...(process.env.APTOS_API_KEY ? { authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}) }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function getJson(u, init) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(u, init).catch((e) => ({ ok: false, status: 0, err: e }))
    if (r.ok) return r.json()
    if (r.status === 404 || r.status === 410) return null
    if (r.status === 0 && i >= 2) throw new Error(`unreachable ${new URL(u).host}: ${r.err?.cause?.code || r.err?.message}`)
    await sleep(2500 * (i + 1))
  }
  throw new Error(`gave up ${u.slice(0, 120)}`)
}
async function gql(query) {
  const j = await getJson(INDEXER, { method: "POST", headers: aptHeaders, body: JSON.stringify({ query }) })
  if (!j || j.errors) throw new Error("indexer: " + JSON.stringify(j?.errors ?? j).slice(0, 200))
  return j.data
}
async function aptTx(v) {
  for (const b of APT) { const t = await getJson(`${b}/transactions/by_version/${v}`, { headers: aptHeaders }); if (t && !t.error_code) return t }
  throw new Error(`aptos tx ${v} not found`)
}

// ── Flow helpers (per spork) ──
const anchors = new Map()
async function blockMs(sp, h) { const b = await getJson(`${sp.rest}/blocks?height=${h}`); if (!b) throw new Error(`${sp.name}: no block ${h}`); return Date.parse(b[0].header.timestamp) }
async function heightAt(sp, ms) {
  if (!anchors.has(sp.name)) {
    const top = sp.end ?? Number((await getJson(`${sp.rest}/blocks?height=sealed`))[0].header.height) - 50
    anchors.set(sp.name, [[sp.root + 10, await blockMs(sp, sp.root + 10)], [top, await blockMs(sp, top)]])
  }
  const a = anchors.get(sp.name)
  for (let k = 0; k < 10; k++) {
    a.sort((x, y) => x[0] - y[0])
    let i = a.findIndex((x) => x[1] >= ms); if (i <= 0) i = 1; if (i < 0) i = a.length - 1
    const [h0, m0] = a[i - 1], [h1, m1] = a[i]
    const est = Math.max(sp.root, Math.round(h0 + (h1 - h0) * (ms - m0) / ((m1 - m0) || 1)))
    const m = await blockMs(sp, est); a.push([est, m])
    if (Math.abs(m - ms) < 20000) return est
  }
  return a.reduce((b, x) => (Math.abs(x[1] - ms) < Math.abs(b[1] - ms) ? x : b))[0]
}
async function flowEvents(sp, type, from, to) {
  const out = []
  for (let s = Math.max(from, sp.root); s <= to; s += 250) {
    const r = await getJson(`${sp.rest}/events?type=${type}&start_height=${s}&end_height=${Math.min(s + 249, to)}`)
    for (const blk of r || []) for (const e of blk.events || []) {
      const p = JSON.parse(Buffer.from(e.payload, "base64"))
      const f = Object.fromEntries(p.value.fields.map((x) => [x.name, x.value?.value?.value ?? x.value?.value ?? null]))
      out.push({ h: Number(blk.block_height), t: blk.block_timestamp, tx: e.transaction_id, ...f })
    }
  }
  return out
}
const sporkFor = (iso) => [...SPORKS].reverse().find((s) => iso >= s.from)

async function matchOne(b) {
  const sp = sporkFor(b.minted_at)
  const tx = await aptTx(b.aptos_version)
  const n = tx.payload.arguments[0].length
  const mintMs = Date.parse(b.minted_at)
  const h = await heightAt(sp, mintMs)
  const hi = sp.end ? Math.min(h + 30, sp.end) : h + 30
  let cand = []
  for (const back of n === 20 ? [900] : [900, 3000]) {
    const burns = await flowEvents(sp, `${UFC}.NFTDestroyed`, h - back, hi)
    const byTx = new Map()
    for (const e of burns) { if (!byTx.has(e.tx)) byTx.set(e.tx, { tx: e.tx, t: e.t, h: e.h, n: 0 }); byTx.get(e.tx).n++ }
    cand = [...byTx.values()].filter((c) => Date.parse(c.t) <= mintMs + 5000).sort((x, y) => y.h - x.h)
    if (cand.length) break
  }
  const best = cand.find((c) => c.n === n) || cand.find((c) => c.n > n) || null
  let from = null
  if (best) from = (await flowEvents(sp, `${UFC}.Withdraw`, best.h, best.h)).find((e) => e.tx === best.tx)?.from ?? null
  return {
    aptos_version: b.aptos_version, minted_at: b.minted_at, aptos_address: b.aptos_address, n_minted: n,
    flow_tx: best?.tx ?? null, flow_address: from, flow_burned_at: best?.t ?? null, burn_size: best?.n ?? null,
    match: best ? (best.n === n ? "count_exact" : "count_superset") : "none", flow_spork: sp.name,
  }
}

// ── main ──
// 2026-11-19: the mint list is PERSISTED (ufc_aptos_mint_txs). Re-listing every mint from version
// 3,180,000,000 took 580–720 s each run, so half the runs died mid-list and the rest had no time left.
// Listing is ascending by version, so the stored set is always a complete PREFIX of the chain's list:
// each run lists only versions above the stored maximum and appends them. Hitting the listing cap now
// keeps what was listed (progress, not a failure) and matching runs on the stored prefix.
const startedAt = new Date().toISOString()
const LIST_FLOOR = 3180000000
let listedNew = 0
let listingComplete = false
const listedThisRun = [] // dry-run writes nothing, so it must see what it listed
{
  const { data: top, error: topErr } = await db.from("ufc_aptos_mint_txs").select("aptos_version").order("aptos_version", { ascending: false }).limit(1)
  if (topErr) throw topErr
  let v = top?.[0]?.aptos_version != null ? Number(top[0].aptos_version) : LIST_FLOOR
  for (;;) {
    const d = await gql(`{token_activities_v2(where:{entry_function_id_str:{_eq:"${ISSUER_FN}"},type:{_eq:"0x1::object::Transfer"},transaction_version:{_gt:${v}}},distinct_on:transaction_version,order_by:{transaction_version:asc},limit:100){transaction_version transaction_timestamp to_address}}`)
    const r = d.token_activities_v2
    const page = r.map((x) => ({ aptos_version: Number(x.transaction_version), minted_at: x.transaction_timestamp + "Z", aptos_address: x.to_address }))
    if (page.length && APPLY) {
      // Write each page before reading the next: the stored set must stay a prefix, never skip a page.
      const { error } = await db.from("ufc_aptos_mint_txs").upsert(page, { onConflict: "aptos_version", ignoreDuplicates: true })
      if (error) throw error
    }
    listedNew += page.length
    if (!APPLY) listedThisRun.push(...page)
    if (r.length < 100) { listingComplete = true; break }
    v = r.at(-1).transaction_version
    if (Date.now() - t0 > ENUM_BUDGET_MS) {
      console.warn(`mint listing hit ${ENUM_BUDGET_MS / 1000}s after ${listedNew} new mints; kept, continuing next run`)
      break
    }
    await sleep(process.env.APTOS_API_KEY ? 100 : 1200)
  }
}
const mints = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("ufc_aptos_mint_txs").select("aptos_version, minted_at, aptos_address").order("aptos_version").range(from, from + 999)
  if (error) throw error
  for (const r of data) mints.push({ aptos_version: Number(r.aptos_version), minted_at: new Date(r.minted_at).toISOString(), aptos_address: r.aptos_address })
  if (data.length < 1000) break
}
{
  const known = new Set(mints.map((m) => m.aptos_version))
  for (const m of listedThisRun) if (!known.has(m.aptos_version)) mints.push(m)
  mints.sort((a, b) => a.aptos_version - b.aptos_version)
}
const done = new Set()
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("ufc_aptos_migration_matches").select("aptos_version").order("aptos_version").range(from, from + 999)
  if (error) throw error
  for (const r of data) done.add(Number(r.aptos_version))
  if (data.length < 1000) break
}
const todo = mints.filter((m) => !done.has(m.aptos_version) && (!ONLY_SPORK || sporkFor(m.minted_at).name === ONLY_SPORK))
console.log(`mode ${APPLY ? "APPLY" : "dry-run"} · ${mints.length} Aptos mint txs · ${done.size} already matched · ${todo.length} to do · key ${process.env.APTOS_API_KEY ? "yes" : "no"}`)

const deadSporks = new Map()
const stats = { processed: 0, written: 0, count_exact: 0, count_superset: 0, none: 0, skipped_unreachable: 0, errors: 0 }
const tMatch = Date.now()
for (let i = 0; i < todo.length && Date.now() - tMatch < BUDGET_MS; i += CONC) {
  const slice = todo.slice(i, i + CONC).filter((b) => !deadSporks.has(sporkFor(b.minted_at).name))
  const rows = []
  await Promise.all(slice.map(async (b) => {
    try { const r = await matchOne(b); rows.push(r); stats[r.match]++ } catch (e) {
      if (/unreachable/.test(e.message)) { const s = sporkFor(b.minted_at).name; if (!deadSporks.has(s)) console.warn(`${s}: ${e.message} — skipping its batches this run`); deadSporks.set(s, e.message); stats.skipped_unreachable++ }
      else { stats.errors++; console.warn(`v${b.aptos_version}: ${e.message}`) }
    }
  }))
  stats.processed += rows.length
  if (rows.length && APPLY) {
    const { error } = await db.from("ufc_aptos_migration_matches").upsert(rows, { onConflict: "aptos_version", ignoreDuplicates: true })
    if (error) throw error
    stats.written += rows.length
  }
  if (stats.processed % 120 < CONC) console.log(`… ${stats.processed} processed (${JSON.stringify(stats)})`)
}
let links = null
if (APPLY) {
  const { data, error } = await db.rpc("refresh_ufc_aptos_wallet_links")
  if (error) throw error
  links = data
}
const summary = { ...stats, links_upserted: links, remaining: todo.length - stats.processed, mints_known: mints.length, listed_new: listedNew, listing_complete: listingComplete, dead_sporks: Object.fromEntries(deadSporks), enum_seconds: Math.round((tMatch - t0) / 1000), seconds: Math.round((Date.now() - t0) / 1000) }
console.log(JSON.stringify(summary))
// Work existed, nothing was matched and nothing explains why (no error, no dead spork) = the run did not
// do its job, whatever else succeeded. ok must say so (11-16 17:25Z run: 0 of 7,987, logged ok=true).
const stalled = todo.length > 0 && stats.processed === 0 && stats.errors === 0 && stats.skipped_unreachable === 0
if (APPLY) {
  const { error } = await db.rpc("log_pipeline_run", {
    p_pipeline: "ufc-aptos-wallet-link", p_started_at: startedAt, p_rows_found: todo.length, p_rows_written: stats.written,
    p_rows_skipped: stats.skipped_unreachable + stats.errors, p_ok: stats.errors === 0 && !stalled,
    p_error: stats.errors ? `${stats.errors} batch errors` : stalled ? `0 of ${todo.length} processed` : null,
    p_collection_slug: "ufc_strike", p_cursor_before: String(done.size), p_cursor_after: String(done.size + stats.written), p_extra: summary,
  })
  if (error) console.warn(`log_pipeline_run failed: ${error.message}`)
}
