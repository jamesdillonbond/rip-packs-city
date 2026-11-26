#!/usr/bin/env node
// scripts/ufc-aptos-identity-link.mjs — UFC Strike: link RPC users' Flow wallets to their Aptos migration wallets
// by MOMENT IDENTITY, without Flow history.
//
// WHY (2026-11-26): ~73 % of UFC Aptos holdings sit with wallets that migrated Aug–Oct 2025 (Flow spork mainnet26).
// scripts/ufc-aptos-wallet-link.mjs matches Flow burns to Aptos mints, but the mainnet26 nodes are gone and the Dune
// path waits for the 2026-12-14 credit reset. UFC's Aptos mint (issuer::mint_for) carries each Moment's serial and
// edition, and serials survived the burn-and-mint. So for a saved user whose Flow UFC Moments RPC already knows,
// the Aptos wallet UFC minted those same Moments to is that user's migration wallet.
// Measured 2026-11-26 PT: 0xaf78…fe85 → 11 of 11 found Moments minted to one wallet; 0xbd94…50ac → 3 of 3.
//
// Per run:
//   1. get_ufc_identity_link_candidates(p_per_wallet) — saved Flow wallets with NO link yet, and Moments they still
//      held as far as RPC's records go (last recorded Flow buyer, or acquired with no later sale to anyone else).
//   2. For each candidate: the Aptos token with that collection + "Serial Number", then its FIRST transfer. Only a
//      first transfer made by UFC's issuer::mint_for counts; UFC's own store/issuer wallets never count as a user's.
//   3. Per wallet, tally mint recipients. Link a recipient only when at least MIN_AGREE Moments agree AND it holds at
//      least MIN_SHARE of the Moments found on Aptos (a user with two Aptos wallets can link both). Confidence 'high'
//      only when every found Moment agrees and there are at least HIGH_AGREE of them; otherwise 'medium'.
//      An Aptos wallet already linked to a DIFFERENT Flow wallet by burn->mint is skipped and reported (conflict).
//   4. Insert method 'moment_identity_match' (never overwrites an existing row: ON CONFLICT DO NOTHING).
// The holdings step that runs after this one picks the new Aptos wallets up the same run.
//
// Needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY; APTOS_API_KEY recommended.
// Usage: node scripts/ufc-aptos-identity-link.mjs [--apply] [--budget-sec 240] [--per-wallet 15]
// Revert: migration audit_20261126_ufc_aptos_identity_link (header) — delete the method's rows, drop the function.

import { createClient } from "@supabase/supabase-js"

const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql"
const ISSUER = "0x80f686c7bba12a0fce839ff160cb69774715497288996b861528727ccd256cdb"
const UFC_OWN = new Set([ISSUER, "0x8a94446716e60160571b930bd1097b31c7788decbe4d375802bebfc79d928e7f"])
const MIN_AGREE = 3
const MIN_SHARE = 0.3
const HIGH_AGREE = 5

const args = process.argv.slice(2)
const APPLY = args.includes("--apply")
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d }
const BUDGET_MS = arg("--budget-sec", 240) * 1000
const PER_WALLET = arg("--per-wallet", 15)
const t0 = Date.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PACE = process.env.APTOS_API_KEY ? 100 : 1300
const headers = { "content-type": "application/json", ...(process.env.APTOS_API_KEY ? { authorization: `Bearer ${process.env.APTOS_API_KEY}` } : {}) }

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function gql(query, variables) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(INDEXER, { method: "POST", headers, body: JSON.stringify({ query, variables }) }).catch(() => null)
    if (r?.ok) {
      const j = await r.json()
      await sleep(PACE)
      if (!j.errors) return j.data
    }
    await sleep(3000 * (i + 1))
  }
  throw new Error("indexer gave up")
}

const { data: cands, error: cErr } = await db.rpc("get_ufc_identity_link_candidates", { p_per_wallet: PER_WALLET })
if (cErr) throw cErr
const byWallet = new Map()
for (const c of cands ?? []) byWallet.set(c.flow_address, [...(byWallet.get(c.flow_address) ?? []), c])
console.log(`mode ${APPLY ? "APPLY" : "dry-run"} · ${byWallet.size} unlinked wallets · ${(cands ?? []).length} candidate moments · key ${process.env.APTOS_API_KEY ? "yes" : "no"}`)

// Aptos wallets already linked by burn->mint to some Flow wallet (a conflict guard, not a filter on the user).
const burnLinked = new Map()
for (let from = 0; ; from += 1000) {
  const { data, error } = await db.from("ufc_aptos_wallet_links").select("flow_address, aptos_address, method")
    .eq("method", "burn_mint_match").order("flow_address", { ascending: true }).order("aptos_address", { ascending: true }).range(from, from + 999)
  if (error) throw error
  for (const r of data) burnLinked.set(r.aptos_address, r.flow_address)
  if (data.length < 1000) break
}

const stats = { wallets: byWallet.size, moments_checked: 0, no_aptos_token: 0, not_issuer_mint: 0, wallets_linked: 0, links: 0, conflicts: 0, undecided: 0, budget_stopped: false }
const rows = []
const report = []
for (const [flow, list] of byWallet) {
  if (Date.now() - t0 > BUDGET_MS) { stats.budget_stopped = true; break }
  const tally = new Map() // recipient -> { n, first, last }
  let found = 0
  for (const c of list) {
    stats.moments_checked++
    const d = await gql(`query($c:String,$p:jsonb){current_token_datas_v2(where:{collection_id:{_eq:$c},token_properties:{_contains:$p}},limit:2){token_data_id}}`,
      { c: c.aptos_collection_id, p: { "Serial Number": String(c.serial_number) } })
    const toks = d.current_token_datas_v2
    if (toks.length !== 1) { stats.no_aptos_token++; continue } // 0 = not migrated; 2+ = ambiguous, never guess
    const a = await gql(`query($t:String){token_activities_v2(where:{token_data_id:{_eq:$t},type:{_eq:"0x1::object::Transfer"}},order_by:{transaction_version:asc},limit:1){to_address entry_function_id_str transaction_timestamp}}`,
      { t: toks[0].token_data_id })
    const f = a.token_activities_v2[0]
    if (!f || f.entry_function_id_str !== `${ISSUER}::issuer::mint_for` || UFC_OWN.has(f.to_address)) { stats.not_issuer_mint++; continue }
    found++
    const t = tally.get(f.to_address) ?? { n: 0, first: f.transaction_timestamp, last: f.transaction_timestamp }
    t.n++
    if (f.transaction_timestamp < t.first) t.first = f.transaction_timestamp
    if (f.transaction_timestamp > t.last) t.last = f.transaction_timestamp
    tally.set(f.to_address, t)
  }
  const picks = [...tally].filter(([, t]) => t.n >= MIN_AGREE && t.n / found >= MIN_SHARE)
  report.push({ flow, candidates: list.length, found, recipients: [...tally].map(([a, t]) => `${a.slice(0, 10)}…:${t.n}`) })
  if (!picks.length) { stats.undecided++; continue }
  let linkedThis = 0
  for (const [aptos, t] of picks) {
    const other = burnLinked.get(aptos)
    if (other && other !== flow) { stats.conflicts++; continue }
    rows.push({
      flow_address: flow, aptos_address: aptos, method: "moment_identity_match",
      confidence: t.n === found && t.n >= HIGH_AGREE ? "high" : "medium",
      burns: 0, exact_burns: 0, moments: t.n,
      first_migrated_at: t.first + "Z", last_migrated_at: t.last + "Z",
      source_window: `identity ${t.n}/${found}`, updated_at: new Date().toISOString(),
    })
    linkedThis++
  }
  if (linkedThis) stats.wallets_linked++
}
stats.links = rows.length

let written = 0
if (APPLY && rows.length) {
  const { data, error } = await db.from("ufc_aptos_wallet_links")
    .upsert(rows, { onConflict: "flow_address,aptos_address", ignoreDuplicates: true }).select("flow_address")
  if (error) throw error
  written = data?.length ?? 0
}
const summary = { ...stats, written, seconds: Math.round((Date.now() - t0) / 1000), report }
console.log(JSON.stringify(summary, null, 1))
if (APPLY) {
  // Reaching here means the read and the insert above both succeeded (each throws on error).
  const { error } = await db.rpc("log_pipeline_run", {
    p_pipeline: "ufc-aptos-identity-link", p_started_at: new Date(t0).toISOString(), p_rows_found: rows.length,
    p_rows_written: written, p_rows_skipped: stats.conflicts + stats.undecided, p_ok: true, p_error: null,
    p_collection_slug: "ufc_strike", p_cursor_before: null, p_cursor_after: null, p_extra: summary,
  })
  if (error) console.warn(`log_pipeline_run failed: ${error.message}`)
}
