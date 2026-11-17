#!/usr/bin/env node
// scripts/ufc-aptos-holdings.mjs — UFC Strike: current Aptos holdings for wallets RPC can tie to a user.
//
// Trevor 2026-11-15: UFC reopens on Aptos only once binders can show a user's Aptos UFC moments.
// Users give RPC their Dapper (Flow) address; ufc_aptos_wallet_links maps it to the Aptos wallet(s) their moments
// were migrated to (see scripts/ufc-aptos-wallet-link.mjs). This script reads what those Aptos wallets own NOW
// (Aptos indexer current_token_ownerships_v2), keeps only UFC Strike tokens (collections in ufc_aptos_collections),
// and refreshes public.ufc_aptos_holdings per owner: upsert what is held, delete what that owner no longer holds.
// Read path: get_ufc_aptos_holdings_for_flow(flow_address). Plan: claude/ufc-reopen-on-aptos-plan-2026-11-16.md.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; APTOS_API_KEY recommended.
// Usage: node scripts/ufc-aptos-holdings.mjs [--apply] [--budget-sec 300] [--owners-per-query 1]
// Revert: DROP the table + function (migration audit_20261116_ufc_aptos_holdings).

import { createClient } from "@supabase/supabase-js"

const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const BUDGET_MS = Number(arg("--budget-sec", 300)) * 1000
const PER_QUERY = Number(arg("--owners-per-query", 1)) // multi-owner _in + order_by times out (408) on the indexer; 1 owner is ~1 s
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PACE = process.env.APTOS_API_KEY ? 100 : 1200
const headers = { "content-type": "application/json", ...(process.env.APTOS_API_KEY ? { authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}) }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function gql(query, variables) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(INDEXER, { method: "POST", headers, body: JSON.stringify({ query, variables }) }).catch(() => null)
    if (r?.ok) { const j = await r.json(); if (!j.errors) { await sleep(PACE); return j.data } console.warn("indexer:", JSON.stringify(j.errors).slice(0, 200)) }
    await sleep(3000 * (i + 1))
  }
  throw new Error("indexer: gave up")
}
// Each caller pages ORDERED BY ITS TABLE'S UNIQUE KEY. Offset paging without a total order can
// skip or repeat rows between pages (2026-11-15, Claude Code; paginated-range-requires-order-ratchet)
// — here that would drop owners from the walk or delete holdings that are still held.
async function selectAll(page) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const cols = await selectAll((a, b) => db.from("ufc_aptos_collections").select("aptos_collection_id, edition_id").order("aptos_collection_id").range(a, b))
const editionOf = new Map(cols.map((c) => [c.aptos_collection_id, c.edition_id]))
const owners = [...new Set((await selectAll((a, b) => db.from("ufc_aptos_wallet_links").select("aptos_address").order("flow_address").order("aptos_address").range(a, b))).map((r) => r.aptos_address))]
// stalest owners first, so a budget-limited run rotates through everyone
const seen = new Map()
for (const r of await selectAll((a, b) => db.from("ufc_aptos_holdings").select("aptos_address, refreshed_at").order("token_data_id").range(a, b))) {
  const prev = seen.get(r.aptos_address); if (!prev || r.refreshed_at < prev) seen.set(r.aptos_address, r.refreshed_at)
}
owners.sort((a, b) => (seen.get(a) ?? "").localeCompare(seen.get(b) ?? ""))
console.log(`mode ${APPLY ? "APPLY" : "dry-run"} · ${owners.length} linked Aptos wallets · ${editionOf.size} UFC collections · key ${process.env.APTOS_API_KEY ? "yes" : "no"}`)

const Q = `query($o:[String!],$off:Int){current_token_ownerships_v2(where:{owner_address:{_in:$o},amount:{_gt:"0"}},order_by:{token_data_id:asc},limit:100,offset:$off){owner_address token_data_id last_transaction_version last_transaction_timestamp current_token_data{collection_id token_properties}}}`
const stats = { owners_done: 0, tokens_held: 0, upserted: 0, removed: 0, non_ufc_skipped: 0 }
for (let i = 0; i < owners.length && Date.now() - t0 < BUDGET_MS; i += PER_QUERY) {
  const group = owners.slice(i, i + PER_QUERY)
  const rows = []
  for (let off = 0; ; off += 100) {
    const page = (await gql(Q, { o: group, off })).current_token_ownerships_v2
    for (const t of page) {
      const coll = t.current_token_data?.collection_id
      if (!editionOf.has(coll)) { stats.non_ufc_skipped++; continue }
      const serial = Number.parseInt(t.current_token_data?.token_properties?.["Serial Number"] ?? "", 10)
      rows.push({
        token_data_id: t.token_data_id, aptos_address: t.owner_address, aptos_collection_id: coll,
        edition_id: editionOf.get(coll) ?? null, serial_number: Number.isFinite(serial) ? serial : null,
        last_tx_version: Number(t.last_transaction_version), last_tx_at: t.last_transaction_timestamp + "Z",
        refreshed_at: new Date().toISOString(),
      })
    }
    if (page.length < 100) break
  }
  stats.tokens_held += rows.length
  if (APPLY) {
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await db.from("ufc_aptos_holdings").upsert(rows.slice(k, k + 500), { onConflict: "token_data_id" })
      if (error) throw error
    }
    stats.upserted += rows.length
    // remove tokens these owners no longer hold
    const held = new Set(rows.map((r) => r.token_data_id))
    const before = await selectAll((a, b) => db.from("ufc_aptos_holdings").select("token_data_id, aptos_address").in("aptos_address", group).order("token_data_id").range(a, b))
    const gone = before.filter((r) => !held.has(r.token_data_id)).map((r) => r.token_data_id)
    for (let k = 0; k < gone.length; k += 200) {
      const { error } = await db.from("ufc_aptos_holdings").delete().in("token_data_id", gone.slice(k, k + 200))
      if (error) throw error
    }
    stats.removed += gone.length
  }
  stats.owners_done += group.length
}
const summary = { ...stats, owners_total: owners.length, seconds: Math.round((Date.now() - t0) / 1000) }
console.log(JSON.stringify(summary))
if (APPLY) {
  const { error } = await db.rpc("log_pipeline_run", {
    p_pipeline: "ufc-aptos-holdings", p_started_at: new Date(t0).toISOString(), p_rows_found: stats.tokens_held,
    p_rows_written: stats.upserted, p_rows_skipped: stats.removed, p_ok: true, p_error: null, p_collection_slug: "ufc_strike",
    p_cursor_before: null, p_cursor_after: String(stats.owners_done), p_extra: summary,
  })
  if (error) console.warn(`log_pipeline_run failed: ${error.message}`)
}
