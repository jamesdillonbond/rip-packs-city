#!/usr/bin/env node
// scripts/ufc-aptos-sales-ingest.mjs — UFC Strike on Aptos: marketplace purchases → public.sales
//
// Context (Trevor 2026-11-15): UFC Strike moved Flow → Aptos in Aug 2025 (burn-and-mint, serials kept).
// Aptos UFC is an EXTENSION of the existing ufc_strike collection: every Aptos collection maps to one
// edition through public.ufc_aptos_collections (UFC Strike's own edition number = Flow set_id).
// Project docs: claude/ufc-strike-aptos-scoping-2026-11-15.md, claude/handoff-2026-11-15-ufc-aptos-sales-ingest.md
//
// What it does, per run:
//   1. Upserts missing APT/USD daily closes into public.apt_usd_daily (Coinbase Exchange APT-USD 1d candles).
//   2. Scans the Aptos indexer (token_activities_v2) for object transfers made by the marketplace purchase
//      entry functions below, from ufc_aptos_ingest_state.scanned_through_version up to the ledger head,
//      in version windows; keeps tokens whose collection is in ufc_aptos_collections.
//   3. Prices each sale from the transaction's OWN marketplace event (BuyEvent / AcceptCollectionBidEvent /
//      Sold / OfferAccepted …) via the fullnode REST API, falling back to the archive endpoint for
//      pruned versions. Bundles and token-for-token offers are skipped (no per-token APT price).
//   4. Inserts rows into public.sales (currency 'APT', price_usd = APT × that UTC day's close,
//      source 'aptos_indexer_v1'); dedupe is the unique index (transaction_hash, nft_id, sold_at).
//   5. Advances the cursor only past fully processed windows.
//
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Optional APTOS_API_KEY (Geomi / Aptos Build;
// without it the public endpoint rate-limits hard — the backfill will crawl).
// Usage:  node scripts/ufc-aptos-sales-ingest.mjs [--apply] [--budget-sec 480] [--window 40000000]
//         dry run is the default: everything is read and priced, nothing is written.
// Revert: disable .github/workflows/ufc-aptos-sales-ingest.yml, then
//   DELETE FROM sales WHERE source = 'aptos_indexer_v1';   (rpc destructive guard: needs the bypass)
//   UPDATE ufc_aptos_ingest_state SET scanned_through_version = 3200000000;

import { createClient } from "@supabase/supabase-js"
import { unknownPurchaseFns } from "./lib/aptos-marketplace-fns.mjs"

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const FULLNODE = "https://api.mainnet.aptoslabs.com/v1"
const ARCHIVE = "https://archive.mainnet.aptoslabs.com/v1"
const TRADEPORT = "0xe11c12ec495f3989c35e1c6a0af414451223305b579291fc8f3d9d0575a23c26"
const RARIBLE = "0xe7201624dc99aee9a6d5f6e9bb3cf2061c4facc92e2aa0c05bf9057508deee77"
const BUY_FNS = [
  `${TRADEPORT}::markets_v2::buy_tokens_v2`,
  `${TRADEPORT}::biddings_v2::accept_collection_bid`,
  `${TRADEPORT}::biddings_v2::unlist_and_accept_collection_bid`,
  `${TRADEPORT}::biddings_v2::accept_token_bid`,
  `${RARIBLE}::marketplace::buy`,
  `${RARIBLE}::bundles::buy_bundle`,
  `${RARIBLE}::offers::accept`,
]
const OCTAS = 1e8

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const argNum = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d }
const BUDGET_MS = argNum("--budget-sec", 480) * 1000
const WINDOW = argNum("--window", 40_000_000)
const PACE_MS = process.env.APTOS_API_KEY ? 150 : 2500
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const aptosHeaders = { "content-type": "application/json", ...(process.env.APTOS_API_KEY ? { authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}) }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function fetchRetry(u, init, label) {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(u, init).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }))
    if (res.ok) { await sleep(PACE_MS); return res }
    if (res.status === 404 || res.status === 410) return res
    const wait = Math.min(60_000, 5_000 * (i + 1))
    console.warn(`${label}: HTTP ${res.status} — retry in ${wait / 1000}s`)
    await sleep(wait)
  }
  throw new Error(`${label}: gave up after retries`)
}

async function gql(query, variables) {
  const res = await fetchRetry(INDEXER, { method: "POST", headers: aptosHeaders, body: JSON.stringify({ query, variables }) }, "indexer")
  const j = await res.json()
  if (j.errors) throw new Error("indexer: " + JSON.stringify(j.errors).slice(0, 300))
  return j.data
}

async function getTx(version) {
  for (const base of [FULLNODE, ARCHIVE]) {
    const res = await fetchRetry(`${base}/transactions/by_version/${version}`, { headers: aptosHeaders }, `tx ${version}`)
    const j = await res.json()
    if (j.error_code === "version_pruned") continue
    if (j.error_code) throw new Error(`tx ${version}: ${j.error_code} ${j.message}`)
    return j
  }
  throw new Error(`tx ${version}: pruned on fullnode and archive`)
}

// ── 1. APT/USD daily closes ───────────────────────────────────────────────────────────────────────
async function refreshAptUsd() {
  const { data: last } = await db.from("apt_usd_daily").select("day").order("day", { ascending: false }).limit(1)
  const from = last?.[0]?.day ? new Date(last[0].day + "T00:00:00Z") : new Date("2025-08-01T00:00:00Z")
  from.setUTCDate(from.getUTCDate() + 1)
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z") // exclude the open UTC day
  if (from >= today) return 0
  const rows = []
  for (let s = new Date(from); s < today; ) {
    const e = new Date(Math.min(s.getTime() + 290 * 86400e3, today.getTime()))
    const res = await fetchRetry(`https://api.exchange.coinbase.com/products/APT-USD/candles?granularity=86400&start=${s.toISOString()}&end=${e.toISOString()}`,
      { headers: { "user-agent": "rippackscity-ufc-aptos" } }, "coinbase")
    for (const [ts, , , , close] of await res.json()) {
      const day = new Date(ts * 1000).toISOString().slice(0, 10)
      if (new Date(day + "T00:00:00Z") < today) rows.push({ day, usd: close, source: "coinbase_apt_usd_1d_close" })
    }
    s = e
  }
  if (rows.length && APPLY) {
    const { error } = await db.from("apt_usd_daily").upsert(rows, { onConflict: "day" })
    if (error) throw error
  }
  return rows.length
}

// ── 3. price one sale from its transaction's marketplace event ───────────────────────────────────
function marketplaceOf(fn) { return fn.startsWith(TRADEPORT) ? "tradeport" : fn.startsWith(RARIBLE) ? "rarible" : null }
const inner = (v) => (v && typeof v === "object" ? v.inner : v)
// ⚠ Aptos addresses come in two spellings: the indexer zero-pads to 64 hex digits
// ("0x0dda0bce…"), event data drops leading zeros ("0xdda0bce…"). Comparing them raw
// skipped every sale of a token whose address starts with 0x0 — 7 of ~50 in the first dry
// run (2026-11-15, Claude Code), all "no marketplace event for token" although the
// BuyEvent was there. Compare normalised; nft_id is still stored as the indexer gives it.
const addr = (v) => {
  const s = String(inner(v) ?? "").toLowerCase().replace(/^0x/, "")
  return s ? "0x" + s.padStart(64, "0") : ""
}

function priceFromEvents(tx, tokenId) {
  const p = priceFromMarketEvent(tx, tokenId)
  if (!p.skip && !p.buyer) {
    // some events (e.g. Tradeport unlist_and_accept_collection_bid) carry no buyer: use the token's final recipient
    const hops = (tx.events ?? []).filter((e) => e.type === "0x1::object::Transfer" && addr(e.data?.object) === addr(tokenId))
    if (hops.length) p.buyer = hops[hops.length - 1].data.to
  }
  return p
}

function priceFromMarketEvent(tx, tokenId) {
  const tok = addr(tokenId)
  for (const ev of tx.events ?? []) {
    const t = ev.type, d = ev.data ?? {}
    if (!(t.startsWith(TRADEPORT) || t.startsWith(RARIBLE))) continue
    if (t.endsWith("::bundles::BundleSold")) {
      if ((d.tokens ?? []).map(addr).includes(tok)) return { skip: "bundle (no per-token price)" }
      continue
    }
    if (t.endsWith("::offers::OfferAccepted")) {
      const give = (d.give_tokens ?? []).map(addr), want = (d.want_tokens ?? []).map(addr)
      if (!give.includes(tok) && !want.includes(tok)) continue
      // APT for exactly this one token, in either direction; anything else is a swap.
      if (give.length === 1 && give[0] === tok && want.length === 0 && Number(d.want_apt) > 0 && Number(d.give_apt) === 0)
        return { octas: Number(d.want_apt), buyer: d.proposer, seller: d.counterparty }
      if (want.length === 1 && want[0] === tok && give.length === 0 && Number(d.give_apt) > 0 && Number(d.want_apt) === 0)
        return { octas: Number(d.give_apt), buyer: d.counterparty, seller: d.proposer }
      return { skip: "offer swap (tokens on both sides or multi-token)" }
    }
    // Tradeport BuyEvent / Accept*BidEvent, Rarible Sold: one token, one price
    if (d.price != null && addr(d.token) === tok)
      return { octas: Number(d.price), buyer: d.buyer ?? d.bid_buyer, seller: d.seller ?? d.bid_seller }
  }
  return { skip: "no marketplace event for token" }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────
const { data: map, error: mapErr } = await db.from("ufc_aptos_collections").select("aptos_collection_id, edition_id").not("edition_id", "is", null)
if (mapErr) throw mapErr
const editionOf = new Map(map.map((r) => [r.aptos_collection_id, r.edition_id]))
const { data: st, error: stErr } = await db.from("ufc_aptos_ingest_state").select("*").eq("id", 1).single()
if (stErr) throw stErr
console.log(`mode ${APPLY ? "APPLY" : "dry-run"} · ${editionOf.size} mapped Aptos collections · cursor v${st.scanned_through_version} · key ${process.env.APTOS_API_KEY ? "yes" : "NO (anonymous)"}`)

console.log(`apt_usd_daily: ${await refreshAptUsd()} new day(s)`)
const { data: px } = await db.from("apt_usd_daily").select("day, usd")
const usdOn = new Map((px ?? []).map((r) => [r.day, Number(r.usd)]))

const head = Number((await (await fetchRetry(`${FULLNODE}/`, { headers: aptosHeaders }, "ledger")).json()).ledger_version)
const Q = `query($lo:bigint,$hi:bigint,$off:Int,$f:[String!]){token_activities_v2(where:{transaction_version:{_gte:$lo,_lt:$hi},type:{_eq:"0x1::object::Transfer"},entry_function_id_str:{_in:$f}},limit:100,offset:$off,order_by:[{transaction_version:asc},{event_index:asc}]){transaction_version event_index transaction_timestamp entry_function_id_str token_data_id current_token_data{collection_id token_properties}}}`

const startedAt = new Date().toISOString()
const cursorBefore = Number(st.scanned_through_version)
let cursor = cursorBefore
const stats = { windows: 0, buys: 0, ufc: 0, priced: 0, inserted: 0, skipped: {} }
while (cursor < head && Date.now() - t0 < BUDGET_MS) {
  const hi = Math.min(cursor + WINDOW, head)
  const found = []
  // KEYSET paging (2026-11-15, Claude Code): the window spans ALL marketplace buys, not just
  // UFC's, and a deep OFFSET in a busy window makes the indexer time out every time ("Upstream
  // took longer than 10000ms"; v3.80B–3.84B: offset 0 and 100 ≈ 1 s, offset 300 → 408, so the
  // lane could never pass that window). Each page restarts at the last version seen and skips
  // only the rows already read AT that version; (transaction_version, event_index) is a total order.
  let pageLo = cursor
  let skipAtLo = 0
  for (;;) {
    const rows = (await gql(Q, { lo: pageLo, hi, off: skipAtLo, f: BUY_FNS })).token_activities_v2
    stats.buys += rows.length
    for (const r of rows) if (editionOf.has(r.current_token_data?.collection_id)) found.push(r)
    if (rows.length < 100) break
    const last = Number(rows[rows.length - 1].transaction_version)
    const atLast = rows.filter((r) => Number(r.transaction_version) === last).length
    skipAtLo = last === pageLo ? skipAtLo + atLast : atLast
    pageLo = last
  }
  // dedupe a token moved twice inside one tx (listing object hop) — one sale per (tx, token)
  const uniq = [...new Map(found.map((r) => [`${r.transaction_version}:${r.token_data_id}`, r])).values()]
  stats.ufc += uniq.length
  const out = []
  const txCache = new Map()
  for (const r of uniq) {
    if (!txCache.has(r.transaction_version)) txCache.set(r.transaction_version, await getTx(r.transaction_version))
    const tx = txCache.get(r.transaction_version)
    if (!tx.success) { stats.skipped["failed tx"] = (stats.skipped["failed tx"] ?? 0) + 1; continue }
    const p = priceFromEvents(tx, r.token_data_id)
    if (p.skip) {
      stats.skipped[p.skip] = (stats.skipped[p.skip] ?? 0) + 1
      console.log(`  skip v${r.transaction_version} ${r.token_data_id.slice(0, 10)}… ${r.entry_function_id_str.split("::").slice(1).join("::")}: ${p.skip}`)
      continue
    }
    const soldAt = new Date(Number(tx.timestamp) / 1000)
    const day = soldAt.toISOString().slice(0, 10)
    const apt = p.octas / OCTAS
    const rate = usdOn.get(day)
    if (!rate) { stats.skipped["no APT/USD for day"] = (stats.skipped["no APT/USD for day"] ?? 0) + 1; continue }
    const serial = Number.parseInt(r.current_token_data?.token_properties?.["Serial Number"] ?? "", 10)
    out.push({
      edition_id: editionOf.get(r.current_token_data.collection_id),
      collection_id: UFC_COLLECTION_ID,
      collection: "ufc_strike",
      serial_number: Number.isFinite(serial) ? serial : null,
      nft_id: r.token_data_id,
      price_native: apt,
      currency: "APT",
      price_usd: Math.round(apt * rate * 100) / 100,
      buyer_address: p.buyer ?? null,
      seller_address: p.seller ?? null,
      marketplace: marketplaceOf(r.entry_function_id_str),
      transaction_hash: tx.hash,
      sold_at: soldAt.toISOString(),
      source: "aptos_indexer_v1",
    })
  }
  stats.priced += out.length
  if (out.length) {
    for (const o of out) console.log(`  ${o.sold_at.slice(0, 10)} ${o.marketplace.padEnd(9)} ${o.price_native.toFixed(4).padStart(10)} APT  $${o.price_usd.toFixed(2).padStart(8)}  #${o.serial_number}  ${o.edition_id}`)
    if (APPLY) {
      const { data: have } = await db.from("sales").select("transaction_hash, nft_id").in("transaction_hash", [...new Set(out.map((o) => o.transaction_hash))])
      const seen = new Set((have ?? []).map((h) => `${h.transaction_hash}:${h.nft_id}`))
      const fresh = out.filter((o) => !seen.has(`${o.transaction_hash}:${o.nft_id}`))
      if (fresh.length) {
        const { error } = await db.from("sales").insert(fresh)
        if (error) throw error
      }
      stats.inserted += fresh.length
    }
  }
  cursor = hi
  stats.windows++
  if (APPLY) {
    const { error } = await db.from("ufc_aptos_ingest_state").update({ scanned_through_version: cursor, updated_at: new Date().toISOString() }).eq("id", 1)
    if (error) throw error
  }
  console.log(`window → v${hi} (${((head - hi) / 1e6).toFixed(0)}M behind head) · ${uniq.length} UFC sale(s)`)
}
// POSITIVE CONTROL (2026-11-20): which marketplace entry functions did the scanned range actually use?
// `buys: 0` read identically for a quiet market and for a BUY_FNS list the marketplaces had moved past
// (every run 11-17 → 11-20 saw 0 buys of ANY collection). A purchase-shaped function the list does not
// know fails the run, naming the version range to re-scan once it is added; a failed probe is recorded
// and does not fail the run (it is a check on the lane, not the lane).
let marketplaceFnsSeen = null, unknownFns = [], probeError = null, indexerSample = null
if (cursor > cursorBefore) {
  try {
    const PQ = `query($lo:bigint,$hi:bigint,$a:String!,$b:String!){token_activities_v2(where:{transaction_version:{_gte:$lo,_lt:$hi},type:{_eq:"0x1::object::Transfer"},_or:[{entry_function_id_str:{_like:$a}},{entry_function_id_str:{_like:$b}}]},distinct_on:entry_function_id_str,order_by:{entry_function_id_str:asc},limit:100){entry_function_id_str}}`
    const rows = (await gql(PQ, { lo: cursorBefore, hi: cursor, a: `${TRADEPORT}::%`, b: `${RARIBLE}::%` })).token_activities_v2
    marketplaceFnsSeen = rows.map((r) => r.entry_function_id_str)
    unknownFns = unknownPurchaseFns(marketplaceFnsSeen, BUY_FNS)
    // Second control: an EMPTY list is itself ambiguous (no marketplace traffic, or the indexer no longer
    // fills entry_function_id_str the way the filters assume). Sample ANY object transfers in the range:
    // rows present with the field filled = the filter works and the marketplaces were quiet.
    if (marketplaceFnsSeen.length === 0) {
      const SQ = `query($lo:bigint,$hi:bigint){token_activities_v2(where:{transaction_version:{_gte:$lo,_lt:$hi},type:{_eq:"0x1::object::Transfer"}},order_by:{transaction_version:desc},limit:50){entry_function_id_str}}`
      const sample = (await gql(SQ, { lo: cursorBefore, hi: cursor })).token_activities_v2
      // Purchase-named functions from ANY address: a marketplace that moved to a new contract ADDRESS is
      // invisible to the address-prefixed filters above.
      const BQ = `query($lo:bigint,$hi:bigint){token_activities_v2(where:{transaction_version:{_gte:$lo,_lt:$hi},type:{_eq:"0x1::object::Transfer"},_or:[{entry_function_id_str:{_ilike:"%::buy%"}},{entry_function_id_str:{_ilike:"%accept%bid%"}}]},distinct_on:entry_function_id_str,order_by:{entry_function_id_str:asc},limit:50){entry_function_id_str}}`
      const anyBuy = (await gql(BQ, { lo: cursorBefore, hi: cursor })).token_activities_v2.map((r) => r.entry_function_id_str)
      indexerSample = { transfers: sample.length, with_entry_fn: sample.filter((r) => r.entry_function_id_str).length,
        fns: [...new Set(sample.map((r) => r.entry_function_id_str).filter(Boolean))].slice(0, 10),
        purchase_fns_any_address: anyBuy }
    }
  } catch (e) {
    probeError = String(e?.message ?? e).slice(0, 300)
  }
}
const controlError = unknownFns.length
  ? `unknown marketplace purchase fn(s) in v${cursorBefore}..v${cursor}: ${unknownFns.join(", ")} — add to BUY_FNS and re-scan that range`
  : null
const summary = { ...stats, cursor, head, caughtUp: cursor >= head, seconds: Math.round((Date.now() - t0) / 1000), keyed: !!process.env.APTOS_API_KEY,
  marketplace_fns_seen: marketplaceFnsSeen, unknown_purchase_fns: unknownFns, indexer_sample: indexerSample, probe_error: probeError }
console.log(JSON.stringify(summary))
if (APPLY) {
  const { error: logErr } = await db.rpc("log_pipeline_run", {
    p_pipeline: "ufc-aptos-sales-ingest",
    p_started_at: startedAt,
    p_rows_found: stats.ufc,
    p_rows_written: stats.inserted,
    p_rows_skipped: stats.ufc - stats.priced,
    p_ok: controlError === null,
    p_error: controlError,
    p_collection_slug: "ufc_strike",
    p_cursor_before: String(cursorBefore),
    p_cursor_after: String(cursor),
    p_extra: summary,
  })
  if (logErr) console.warn(`log_pipeline_run failed: ${logErr.message}`)
}
if (controlError) { console.error(controlError); process.exit(1) }
