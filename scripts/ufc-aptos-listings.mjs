#!/usr/bin/env node
// scripts/ufc-aptos-listings.mjs — UFC Strike: live Rarible listings on Aptos -> public.ufc_aptos_listings.
//
// Why (measured 2026-11-15): 255 live UFC listings on Rarible across 198 editions, and RPC's UFC FMV was ABOVE the
// cheapest live ask on 100 of 166 editions. UFC's own store wallet (0x8a94…7e8f) posts ~78% of single listings.
// v_ufc_aptos_edition_floor turns this table into a per-edition floor (edition page "UFC ASK", FMV ask ceiling).
// Plan: claude/ufc-reopen-on-aptos-plan-2026-11-16.md (improvements backlog item 1).
//
// Re-measured 2026-11-25 PT: Rarible is the only UFC venue on Aptos (Tradeport dormant since 2026-09-08; UFC's
// issuer exposes only mint/burn/transfer). Rarible recorded 5 purchases across ALL Aptos collections from
// 2026-09-13 to 2026-11-25, the last on 10-22 — so asks, not sales, are UFC's only live price evidence.
// The table and view shipped 11-16 (migration 20261116043121) but this script and its workflow step did not,
// so ufc_aptos_listings stayed empty until 2026-11-25.
//
// Per run:
//   1. Scan new listing transfers (Rarible marketplace::list, bundles::list_bundle) from
//      ufc_aptos_ingest_state.listings_scanned_through_version (default: Aptos UFC launch) to the ledger head,
//      keep UFC collections, read price/seller from the tx's marketplace::Listed event (bundles: one price for the
//      bundle, stored as bundle_price_apt; per-token price NULL), and upsert one row per listing object.
//   2. Re-check every stored listing: live while the token's current owner is the listing object; deleted only when
//      the indexer reports a DIFFERENT owner (sold or delisted). A token with no ownership row in the read is
//      UNKNOWN, not gone: it is kept (last_checked_at untouched, so it is re-read first next run) and counted.
//      Sales themselves are recorded by scripts/ufc-aptos-sales-ingest.mjs.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; APTOS_API_KEY recommended.
// Usage: node scripts/ufc-aptos-listings.mjs [--apply] [--budget-sec 300] [--window 40000000]
// Revert: remove the workflow step; migration audit_20261116_ufc_aptos_listings drops view + table + cursor column.

import { createClient } from "@supabase/supabase-js"

const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const APT = ["https://api.mainnet.aptoslabs.com/v1", "https://archive.mainnet.aptoslabs.com/v1"]
const RARIBLE = "0xe7201624dc99aee9a6d5f6e9bb3cf2061c4facc92e2aa0c05bf9057508deee77"
const LIST_FNS = [`${RARIBLE}::marketplace::list`, `${RARIBLE}::bundles::list_bundle`]
// Rarible's Aptos marketplace package was published at v7,142,111,534 (2026-09-09 PT; first tx on the account
// v7,142,108,457). No Rarible listing can predate it. The 11-16 draft started at UFC's first mint (v3.18B) and the
// first run (2026-11-25 7:59 PM PT) 408'd at offset 0: a filter matching nothing makes the indexer scan the whole
// 40M-version window and time out.
const START_VERSION = 7142100000
const MIN_WINDOW = 1_000_000

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d }
const BUDGET_MS = arg("--budget-sec", 300) * 1000
const WINDOW = arg("--window", 40_000_000)
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PACE = process.env.APTOS_API_KEY ? 100 : 1300
const headers = { "content-type": "application/json", ...(process.env.APTOS_API_KEY ? { authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}) }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function getJson(u, init) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(u, init).catch(() => null)
    if (r?.ok) { await sleep(PACE); return r.json() }
    if (r && (r.status === 404 || r.status === 410)) return null
    await sleep(3000 * (i + 1))
  }
  throw new Error(`gave up ${u.slice(0, 100)}`)
}
class IndexerTimeout extends Error {}
// One window query WITHOUT the retry loop on a 408: the caller halves the window instead of re-sending a
// query the indexer has already said is too heavy. Other failures (429, 5xx) still go through getJson's backoff.
async function gqlWindow(query, variables) {
  const r = await fetch(INDEXER, { method: "POST", headers, body: JSON.stringify({ query, variables }) }).catch(() => null)
  if (r?.ok) {
    const j = await r.json()
    await sleep(PACE)
    if (j?.errors?.some((e) => String(e?.extensions?.code) === "408")) throw new IndexerTimeout("408")
    if (!j || j.errors) throw new Error("indexer: " + JSON.stringify(j?.errors ?? j).slice(0, 200))
    return j.data
  }
  if (r?.status === 408) throw new IndexerTimeout("408")
  return gql(query, variables)
}
async function gql(query, variables) {
  const j = await getJson(INDEXER, { method: "POST", headers, body: JSON.stringify({ query, variables }) })
  if (!j || j.errors) throw new Error("indexer: " + JSON.stringify(j?.errors ?? j).slice(0, 200))
  return j.data
}
async function aptTx(v) {
  for (const b of APT) { const t = await getJson(`${b}/transactions/by_version/${v}`, { headers }); if (t && !t.error_code) return t }
  return null
}
// Paged reads: each ordered by its table's primary key, so pages never overlap or skip.
async function pageAll(page) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}
const readCollections = () => pageAll((a, b) =>
  db.from("ufc_aptos_collections").select("aptos_collection_id, edition_id").order("aptos_collection_id", { ascending: true }).range(a, b))
const readListings = () => pageAll((a, b) =>
  db.from("ufc_aptos_listings").select("listing_address, token_data_id, last_checked_at").order("listing_address", { ascending: true }).range(a, b))

const cols = await readCollections()
const editionOf = new Map(cols.map((c) => [c.aptos_collection_id, c.edition_id]))
const { data: st, error: stErr } = await db.from("ufc_aptos_ingest_state").select("listings_scanned_through_version").eq("id", 1).single()
if (stErr) throw stErr
const head = Number((await getJson(`${APT[0]}/`, { headers })).ledger_version)
let cursor = Number(st.listings_scanned_through_version ?? START_VERSION)
const cursorBefore = cursor
console.log(`mode ${APPLY ? "APPLY" : "dry-run"} · cursor v${cursor} · head v${head} · key ${process.env.APTOS_API_KEY ? "yes" : "no"}`)

// ── 1. new listings ──
const Q = `query($lo:bigint,$hi:bigint,$o:Int,$f:[String!]){token_activities_v2(where:{transaction_version:{_gte:$lo,_lt:$hi},type:{_eq:"0x1::object::Transfer"},entry_function_id_str:{_in:$f}},limit:100,offset:$o,order_by:[{transaction_version:asc},{event_index:asc}]){transaction_version event_index transaction_timestamp entry_function_id_str token_data_id to_address current_token_data{collection_id token_properties}}}`
const stats = { windows: 0, new_listings: 0, closed: 0, still_live: 0, owner_unknown: 0, unpriced: 0, timeouts: 0 }
if (cursor < START_VERSION) cursor = START_VERSION
let win = WINDOW
while (cursor < head && Date.now() - t0 < BUDGET_MS * 0.6) {
  const hi = Math.min(cursor + win, head)
  const found = []
  try {
  // KEYSET paging, as in scripts/ufc-aptos-sales-ingest.mjs (2026-11-15): a deep OFFSET in a busy window
  // makes the indexer 408 ("Upstream took longer than 10000ms"). The first run of this lane (2026-11-25
  // 7:59 PM PT) died exactly so in its first windows. Each page restarts at the last version seen and skips
  // only the rows already read AT that version; (transaction_version, event_index) is a total order.
  let pageLo = cursor
  let skipAtLo = 0
  for (;;) {
    const rows = (await gqlWindow(Q, { lo: pageLo, hi, o: skipAtLo, f: LIST_FNS })).token_activities_v2
    for (const r of rows) if (editionOf.has(r.current_token_data?.collection_id)) found.push(r)
    if (rows.length < 100) break
    const last = Number(rows[rows.length - 1].transaction_version)
    const atLast = rows.filter((r) => Number(r.transaction_version) === last).length
    skipAtLo = last === pageLo ? skipAtLo + atLast : atLast
    pageLo = last
  }
  } catch (e) {
    if (!(e instanceof IndexerTimeout)) throw e
    // Too heavy: retry the SAME start with half the window. The cursor has not moved, so nothing is skipped.
    stats.timeouts++
    if (win <= MIN_WINDOW) throw new Error(`indexer 408 even at a ${MIN_WINDOW}-version window from v${cursor}`)
    win = Math.max(MIN_WINDOW, Math.floor(win / 2))
    continue
  }
  const txCache = new Map()
  const out = []
  for (const r of found) {
    if (!txCache.has(r.transaction_version)) txCache.set(r.transaction_version, await aptTx(r.transaction_version))
    const tx = txCache.get(r.transaction_version)
    const bundle = r.entry_function_id_str.endsWith("::bundles::list_bundle")
    const ev = tx?.events?.find((e) => e.type.startsWith(RARIBLE) && /::(marketplace::Listed|bundles::\w*Listed)$/.test(e.type))
    const priceApt = ev?.data?.price != null ? Number(ev.data.price) / 1e8 : null
    if (priceApt == null) stats.unpriced++
    const serial = Number.parseInt(r.current_token_data?.token_properties?.["Serial Number"] ?? "", 10)
    out.push({
      listing_address: r.to_address, token_data_id: r.token_data_id, aptos_collection_id: r.current_token_data.collection_id,
      edition_id: editionOf.get(r.current_token_data.collection_id) ?? null, serial_number: Number.isFinite(serial) ? serial : null,
      kind: bundle ? "bundle" : "single", marketplace: "rarible",
      price_apt: bundle ? null : priceApt, bundle_price_apt: bundle ? priceApt : null,
      seller: ev?.data?.seller ?? tx?.sender ?? null,
      listed_version: Number(r.transaction_version), listed_at: r.transaction_timestamp + "Z", last_checked_at: new Date().toISOString(),
    })
  }
  // Write the window's rows BEFORE advancing the cursor past them.
  if (APPLY && out.length) {
    const { error } = await db.from("ufc_aptos_listings").upsert(out, { onConflict: "listing_address" })
    if (error) throw error
  }
  stats.new_listings += out.length
  cursor = hi
  stats.windows++
  win = Math.min(WINDOW, win * 2) // grow back after a successful window
  if (APPLY) {
    const { error } = await db.from("ufc_aptos_ingest_state").update({ listings_scanned_through_version: cursor }).eq("id", 1)
    if (error) throw error
  }
}

// ── 2. liveness re-check of stored listings (oldest-checked first) ──
const stored = (await readListings())
  .sort((a, b) => a.last_checked_at.localeCompare(b.last_checked_at))
for (let i = 0; i < stored.length && Date.now() - t0 < BUDGET_MS; i += 50) {
  const batch = stored.slice(i, i + 50)
  const d = await gql(`query($t:[String!]){current_token_ownerships_v2(where:{token_data_id:{_in:$t},amount:{_gt:"0"}}){token_data_id owner_address}}`, { t: batch.map((b) => b.token_data_id) })
  const owner = new Map(d.current_token_ownerships_v2.map((o) => [o.token_data_id, o.owner_address]))
  const live = batch.filter((b) => owner.get(b.token_data_id) === b.listing_address)
  const gone = batch.filter((b) => owner.has(b.token_data_id) && owner.get(b.token_data_id) !== b.listing_address)
  stats.owner_unknown += batch.length - live.length - gone.length
  stats.still_live += live.length
  stats.closed += gone.length
  if (APPLY) {
    if (gone.length) {
      const { error } = await db.from("ufc_aptos_listings").delete().in("listing_address", gone.map((g) => g.listing_address))
      if (error) throw error
    }
    if (live.length) {
      const { error } = await db.from("ufc_aptos_listings").update({ last_checked_at: new Date().toISOString() }).in("listing_address", live.map((l) => l.listing_address))
      if (error) throw error
    }
  }
}

const summary = { ...stats, cursor, head, caughtUp: cursor >= head, stored: stored.length, seconds: Math.round((Date.now() - t0) / 1000) }
console.log(JSON.stringify(summary))
if (APPLY) {
  // Every write above throws on error, so reaching here means each one landed.
  const { error } = await db.rpc("log_pipeline_run", {
    p_pipeline: "ufc-aptos-listings", p_started_at: new Date(t0).toISOString(), p_rows_found: stats.new_listings,
    p_rows_written: stats.new_listings, p_rows_skipped: stats.closed, p_ok: true, p_error: null, p_collection_slug: "ufc_strike",
    p_cursor_before: String(cursorBefore), p_cursor_after: String(cursor), p_extra: summary,
  })
  if (error) console.warn(`log_pipeline_run failed: ${error.message}`)
}
