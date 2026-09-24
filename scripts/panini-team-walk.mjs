#!/usr/bin/env node
// scripts/panini-team-walk.mjs — Panini NBA/MLB team walk for franchise hubs (2026-09-24).
//
// Walks Panini's marketplace grid FILTERED BY TEAM
//   https://nft.paniniamerica.net/marketplace/nfts.html?sport=<Sport>&team=<Team>&p=<N>
// in a headless Chromium, reads the SPA's own `products` responses (30 listed NFTs a
// page, each carrying `team`), and hands them to public.panini_team_listings_ingest.
// Nothing here is shown on the site: the rows land in a service-role-only staging
// table until Panini NBA/MLB clears the accuracy gate (docs/features/franchise-hubs.md).
//
// ⚠ WHY THE RESPONSE AND NOT A REPLAY. Panini signs every /onepanini request; the page
// builds and signs its own `products` query, and page.on("response") reads the answer
// at the network layer. RPC never forges, stores or replays a signature.
//
// ⚠ END OF LIST = A `products` RESPONSE WITH ZERO ITEMS. A page that never answered is
// NOT the end — it is a failed read, and the walk stops INCOMPLETE. Only a complete walk
// may retire listings it did not see (an add-only refresh never learns a listing sold;
// a partial walk that retired would delete live listings). Measured 2026-09-24: past the
// last page the grid answers with an empty list.
//
// Env:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (not needed with DRY_RUN=1)
//   PANINI_TEAM_TARGETS  "Basketball:Portland Trail Blazers;Baseball:Detroit" (default)
//   PANINI_MAX_PAGES     per target, default 400 (Blazers measured at 150–250 pages)
//   PANINI_PAGE_DELAY_MS pause between pages, default 1500
//   DRY_RUN=1            walk and report, write nothing (prints a JSON summary)
//   CHROMIUM_PATH        optional executablePath (sandboxes with a preinstalled Chromium)

import { pathToFileURL } from "node:url"

export const BASE = "https://nft.paniniamerica.net/marketplace/nfts.html"
export const DEFAULT_TARGETS = "Basketball:Portland Trail Blazers;Baseball:Detroit"
const FLUSH_EVERY_PAGES = 10

/** "Sport:Team;Sport:Team" -> [{ sport, team }]. Throws on a malformed entry. */
export function parseTargets(raw) {
  const out = []
  for (const part of String(raw || "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":")
    if (i <= 0 || i === part.length - 1) throw new Error(`bad PANINI_TEAM_TARGETS entry: "${part}" (want Sport:Team)`)
    const sport = part.slice(0, i).trim()
    const team = part.slice(i + 1).trim()
    if (!/^(Basketball|Baseball)$/.test(sport)) throw new Error(`unsupported sport "${sport}" (Basketball | Baseball)`)
    out.push({ sport, team })
  }
  if (out.length === 0) throw new Error("PANINI_TEAM_TARGETS is empty")
  return out
}

export function pageUrl(sport, team, page) {
  const q = new URLSearchParams({ sport, team, p: String(page) })
  return `${BASE}?${q.toString()}`
}

const num = (v) => {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** One grid item -> the row shape panini_team_listings_ingest reads. Null when unusable. */
export function toRow(item) {
  if (!item || typeof item.sku !== "string" || typeof item.psku !== "string") return null
  return {
    sku: item.sku,
    psku: item.psku,
    team: typeof item.team === "string" ? item.team : null,
    athlete: typeof item.athlete === "string" ? item.athlete : null,
    cardset: typeof item.cardset === "string" ? item.cardset : null,
    genesis_year: num(item.genesis_year),
    rarity: typeof item.rarity === "string" ? item.rarity : null,
    end_seq: num(item.end_seq),
    price_usd: num(item.buy_now_price) ?? num(item.final_price) ?? num(item.price),
    nft_type: typeof item.nft_type === "string" ? item.nft_type : null,
  }
}

/** Is this network response the grid's `products` query? */
export function isProductsResponse(url, postData) {
  if (!String(url).includes("/onepanini")) return false
  try {
    return JSON.parse(postData || "{}").operationName === "products"
  } catch {
    return false
  }
}

async function walkTarget(page, target, { maxPages, delayMs, onFlush, log }) {
  const rows = new Map()
  let pending = []
  let pages = 0
  let complete = false
  let error = null
  for (let p = 1; p <= maxPages; p++) {
    let items = null
    for (let attempt = 1; attempt <= 2 && items == null; attempt++) {
      const waitProducts = page
        .waitForResponse((r) => isProductsResponse(r.url(), r.request().postData()), { timeout: 45_000 })
        .then(async (r) => (await r.json())?.data?.products?.items)
        .catch((e) => {
          log(`  p${p} attempt ${attempt}: no products response (${e.message.split("\n")[0]})`)
          return null
        })
      await page.goto(pageUrl(target.sport, target.team, p), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
        log(`  p${p} attempt ${attempt}: goto failed (${e.message.split("\n")[0]})`)
      })
      const got = await waitProducts
      items = Array.isArray(got) ? got : null
    }
    if (items == null) {
      error = `page ${p}: no readable products response after 2 attempts`
      break
    }
    pages = p
    if (items.length === 0) {
      complete = true
      break
    }
    for (const it of items) {
      const r = toRow(it)
      if (r && !rows.has(r.sku)) {
        rows.set(r.sku, r)
        pending.push(r)
      }
    }
    if (p % FLUSH_EVERY_PAGES === 0 && pending.length) {
      await onFlush(pending, false)
      pending = []
    }
    await page.waitForTimeout(delayMs)
  }
  if (!complete && !error) error = `hit PANINI_MAX_PAGES=${maxPages} before the end of the list`
  return { rows, pending, pages, complete, error }
}

async function main() {
  const targets = parseTargets(process.env.PANINI_TEAM_TARGETS || DEFAULT_TARGETS)
  const maxPages = Number(process.env.PANINI_MAX_PAGES || 400)
  const delayMs = Number(process.env.PANINI_PAGE_DELAY_MS || 1500)
  const dry = process.env.DRY_RUN === "1"
  const log = (...a) => console.log("[panini-team-walk]", ...a)

  let db = null
  if (!dry) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (or set DRY_RUN=1)")
    const { createClient } = await import("@supabase/supabase-js")
    db = createClient(url, key, { auth: { persistSession: false } })
  }

  const { chromium } = await import("playwright")
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const summary = []
  let anyFailed = false
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
    const page = await ctx.newPage()
    for (const target of targets) {
      const started = new Date()
      const label = `${target.sport}:${target.team}`
      // Heartbeat BEFORE the work, so a killed job is visible as a heartbeat with no finish.
      if (db) {
        const hb = await db.rpc("log_pipeline_run", { p_pipeline: "panini-team-walk-heartbeat", p_ok: true, p_extra: { target: label } })
        if (hb.error) log(`heartbeat write failed: ${hb.error.message}`)
      }
      const acc = { written: 0, mapped: 0, unmapped: 0, retired: 0 }
      const writeErrors = []
      const onFlush = async (batch, complete) => {
        if (!db) return
        const { data, error } = await db.rpc("panini_team_listings_ingest", {
          p_sport: target.sport,
          p_team_raw: target.team,
          p_walk_started_at: started.toISOString(),
          p_rows: batch,
          p_complete: complete,
        })
        if (error) {
          writeErrors.push(error.message)
          return
        }
        for (const k of Object.keys(acc)) acc[k] += Number(data?.[k] ?? 0)
      }
      log(`walking ${label}`)
      const res = await walkTarget(page, target, { maxPages, delayMs, onFlush, log })
      // Final flush. `complete` is passed ONLY when the list ended AND every write landed,
      // because retirement trusts that this walk saw everything that is still listed.
      const retireAllowed = res.complete && writeErrors.length === 0
      if (res.pending.length || retireAllowed) await onFlush(res.pending, retireAllowed)
      const ok = res.complete && writeErrors.length === 0
      if (!ok) anyFailed = true
      const error = [res.error, ...writeErrors.slice(0, 3)].filter(Boolean).join(" | ") || null
      const line = { target: label, pages: res.pages, listings_seen: res.rows.size, complete: res.complete, ...acc, write_errors: writeErrors.length, ok, error }
      summary.push(line)
      log(JSON.stringify(line))
      if (db) {
        const lr = await db.rpc("log_pipeline_run", {
          p_pipeline: "panini-team-walk",
          p_started_at: started.toISOString(),
          p_rows_found: res.rows.size,
          p_rows_written: acc.written,
          p_rows_skipped: 0,
          p_ok: ok,
          p_error: error,
          p_collection_slug: "panini_blockchain",
          p_extra: { target: label, pages: res.pages, complete: res.complete, mapped: acc.mapped, unmapped: acc.unmapped, retired: acc.retired, write_errors: writeErrors.length },
        })
        if (lr.error) {
          log(`run log write failed: ${lr.error.message}`)
          anyFailed = true
        }
      }
    }
  } finally {
    await browser.close()
  }
  if (dry) console.log(JSON.stringify({ dry_run: true, summary }, null, 2))
  if (anyFailed) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error("[panini-team-walk] fatal:", e instanceof Error ? e.stack : e)
    process.exit(2)
  })
}
