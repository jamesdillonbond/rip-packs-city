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
// ⚠ WHERE IT RUNS. Panini's Cloudflare answers GitHub Actions runners with a 403
// (1000-series error box, measured 2026-09-24), so this runs on Trevor's box from
// scripts/panini-run.bat, after the soccer runner, in the same debug Chrome
// (PANINI_CDP_URL) — and posts to /api/cron/panini-team-walk with INGEST_SECRET_TOKEN.
// It needs no service-role key. At most one full pass a day (PANINI_TEAM_WALK_STAMP).
//
// Env:
//   RPC_PANINI_TEAM_WALK_URL  https://www.rippackscity.com/api/cron/panini-team-walk
//   INGEST_SECRET_TOKEN       bearer for that route          (neither needed with DRY_RUN=1)
//   PANINI_CDP_URL            optional: drive an existing Chrome (the runner's debug profile)
//   PANINI_TEAM_TARGETS       "Basketball:Portland Trail Blazers;Baseball:Detroit" (default)
//   PANINI_MAX_PAGES          per target, default 400 (Blazers measured at 150–250 pages)
//   PANINI_PAGE_DELAY_MS      pause between pages, default 1500
//   PANINI_TEAM_WALK_STAMP    optional file: skip when it already holds today's date; written
//                             only after EVERY target completed and every write landed
//   DRY_RUN=1                 walk and report, write nothing
//   CHROMIUM_PATH             optional executablePath when launching (no CDP)

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
      const resp = await page.goto(pageUrl(target.sport, target.team, p), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
        log(`  p${p} attempt ${attempt}: goto failed (${e.message.split("\n")[0]})`)
        return null
      })
      const got = await waitProducts
      items = Array.isArray(got) ? got : null
      if (items == null) {
        // Say WHAT came back, so a block (Cloudflare challenge, 403) is told apart from
        // a slow page. Title + a body snippet only — never cookies or headers.
        const title = await page.title().catch(() => "?")
        const body = await page.evaluate(() => (document.body?.innerText || "").slice(0, 160)).catch(() => "?")
        log(`  p${p} attempt ${attempt}: http=${resp ? resp.status() : "none"} title=${JSON.stringify(title)} body=${JSON.stringify(body.replace(/\s+/g, " "))}`)
      }
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

/** Local calendar day, YYYY-MM-DD — the stamp's unit. */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** POST one op to the receiver. Resolves { ok, status, data } — never throws. */
async function post(url, token, body) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    let data = null
    try {
      data = await r.json()
    } catch {
      data = null
    }
    return { ok: r.ok, status: r.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e instanceof Error ? e.message : String(e) } }
  }
}

async function main() {
  const fs = await import("node:fs")
  const targets = parseTargets(process.env.PANINI_TEAM_TARGETS || DEFAULT_TARGETS)
  const maxPages = Number(process.env.PANINI_MAX_PAGES || 400)
  const delayMs = Number(process.env.PANINI_PAGE_DELAY_MS || 1500)
  const dry = process.env.DRY_RUN === "1"
  const stampFile = process.env.PANINI_TEAM_WALK_STAMP || ""
  const log = (...a) => console.log("[panini-team-walk]", ...a)

  const today = localDay()
  if (!dry && stampFile && fs.existsSync(stampFile) && fs.readFileSync(stampFile, "utf8").trim() === today) {
    log(`already completed today (${today}) — skipping`)
    return
  }

  const url = process.env.RPC_PANINI_TEAM_WALK_URL
  const token = process.env.INGEST_SECRET_TOKEN
  if (!dry && (!url || !token)) throw new Error("RPC_PANINI_TEAM_WALK_URL / INGEST_SECRET_TOKEN missing (or set DRY_RUN=1)")

  const { chromium } = await import("playwright")
  const cdp = process.env.PANINI_CDP_URL
  const browser = cdp
    ? await chromium.connectOverCDP(cdp, { timeout: 30_000 })
    : await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const ctx = cdp ? browser.contexts()[0] ?? (await browser.newContext()) : await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const page = await ctx.newPage()
  const summary = []
  let anyFailed = false
  try {
    for (const target of targets) {
      const startedIso = new Date().toISOString()
      const label = `${target.sport}:${target.team}`
      const base = { sport: target.sport, team: target.team, walk_started_at: startedIso }
      // Heartbeat BEFORE the work, so a killed walk is visible as a start with no finish.
      if (!dry) {
        const hb = await post(url, token, { op: "heartbeat", ...base })
        if (!hb.ok) log(`heartbeat not recorded (http ${hb.status})`)
      }
      const acc = { written: 0, mapped: 0, unmapped: 0, retired: 0 }
      const writeErrors = []
      const onFlush = async (batch, complete) => {
        if (dry) return
        for (let i = 0; i < Math.max(batch.length, 1); i += 1000) {
          const chunk = batch.slice(i, i + 1000)
          const last = i + 1000 >= batch.length
          const r = await post(url, token, { op: "ingest", ...base, rows: chunk, complete: complete && last })
          if (!r.ok || typeof r.data?.written !== "number") {
            writeErrors.push(`ingest http ${r.status}: ${r.data?.error ?? r.data?.message ?? "no write count"}`)
            continue
          }
          for (const k of Object.keys(acc)) acc[k] += Number(r.data?.[k] ?? 0)
        }
      }
      log(`walking ${label}`)
      const res = await walkTarget(page, target, { maxPages, delayMs, onFlush, log })
      // `complete` goes out ONLY when the list ended AND every earlier write landed:
      // retirement trusts that this walk saw everything still listed.
      const retireAllowed = res.complete && writeErrors.length === 0
      if (res.pending.length || retireAllowed) await onFlush(res.pending, retireAllowed)
      const ok = res.complete && writeErrors.length === 0
      if (!ok) anyFailed = true
      const error = [res.error, ...writeErrors.slice(0, 3)].filter(Boolean).join(" | ") || null
      const line = { target: label, pages: res.pages, listings_seen: res.rows.size, complete: res.complete, ...acc, write_errors: writeErrors.length, ok, error }
      summary.push(line)
      log(JSON.stringify(line))
      if (!dry) {
        const fin = await post(url, token, {
          op: "finish",
          ...base,
          pages: res.pages,
          listings_seen: res.rows.size,
          written: acc.written,
          ok,
          error,
          extra: { complete: res.complete, mapped: acc.mapped, unmapped: acc.unmapped, retired: acc.retired, write_errors: writeErrors.length },
        })
        if (!fin.ok) {
          log(`run row not recorded (http ${fin.status})`)
          anyFailed = true
        }
      }
    }
  } finally {
    await page.close().catch(() => {})
    // Over CDP the browser is the runner's debug Chrome — disconnect, never close it.
    if (!cdp) await browser.close().catch(() => {})
  }
  if (dry) console.log(JSON.stringify({ dry_run: true, summary }, null, 2))
  if (!dry && !anyFailed && stampFile) fs.writeFileSync(stampFile, today)
  if (anyFailed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => {
    console.error("[panini-team-walk] fatal:", e instanceof Error ? e.stack : e)
    process.exit(2)
  })
}
