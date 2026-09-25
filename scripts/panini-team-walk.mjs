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
// (1000-series error box, measured 2026-09-24), so this runs on Trevor's box from its
// OWN daily Windows task (scripts/panini-team-walk.bat, 3:35 AM, between the soccer
// runner's 2 AM and 6 AM slots) in the runner's debug Chrome (PANINI_CDP_URL), and
// posts to /api/cron/panini-team-walk with INGEST_SECRET_TOKEN — no service-role key.
// Rotation mode walks the 5 stalest roster teams per run (~weekly per team); at most
// one pass a day (PANINI_TEAM_WALK_STAMP).
//
// Env:
//   RPC_PANINI_TEAM_WALK_URL  https://www.rippackscity.com/api/cron/panini-team-walk
//   INGEST_SECRET_TOKEN       bearer for that route          (neither needed with DRY_RUN=1)
//   PANINI_CDP_URL            optional: drive an existing Chrome (the runner's debug profile)
//   PANINI_TEAM_TARGETS       explicit list "Sport:Team;Sport:Team" (wins over rotation)
//   PANINI_TEAM_ROTATION      N: ask the receiver for the N stalest roster teams
//                             (panini_team_walk_targets); unset + no list = Blazers + Detroit
//   PANINI_WALK_BUDGET_MIN    do not START a team after this many minutes, default 100
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
export const MAX_PAGE_ATTEMPTS = 4

/**
 * Pause before attempt N of one page. The first laptop run lost Blazers at p15 to two
 * BACK-TO-BACK non-JSON answers that were readable minutes later — a transient throttle
 * an immediate retry cannot outlast. Worst case adds ~3.3 min to one page; a page that
 * still fails after that ends the walk INCOMPLETE (nothing retired), as before.
 */
export function retryBackoffMs(attempt) {
  return [0, 0, 20_000, 60_000, 120_000][attempt] ?? 120_000
}

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

/**
 * Items on a team-filtered page whose `team` does not name the target. Panini writes a
 * two-team card as "A | B", so the check is an exact match on any `|` part.
 */
export function foreignTeamItems(items, team) {
  return items.filter((it) => {
    const parts = typeof it?.team === "string" ? it.team.split("|").map((x) => x.trim()) : []
    return !parts.includes(team)
  })
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

/** Pause before re-reading a page that answered EMPTY, to confirm it really is the end. */
export const EMPTY_CONFIRM_WAIT_MS = 20_000

async function walkTarget(page, target, { maxPages, delayMs, onFlush, log }) {
  const rows = new Map()
  let pending = []
  let pages = 0
  let complete = false
  let error = null

  // One page, with backoff retries. Resolves the items array, or null when no attempt
  // produced a readable products answer.
  const readPage = async (p) => {
    let items = null
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS && items == null; attempt++) {
      const backoff = retryBackoffMs(attempt)
      if (backoff > 0) {
        log(`  p${p}: backing off ${Math.round(backoff / 1000)}s before attempt ${attempt}`)
        await page.waitForTimeout(backoff)
      }
      const waitProducts = page
        .waitForResponse((r) => isProductsResponse(r.url(), r.request().postData()), { timeout: 45_000 })
        .then(async (r) => {
          // Read TEXT first: a throttled products call answers HTML with a 200-series or
          // 4xx status, and r.json() would hide which (measured 2026-09-24: Blazers p15
          // returned "<!DOCTYPE" twice back-to-back, then JSON when re-read later).
          const text = await r.text()
          try {
            return JSON.parse(text)?.data?.products?.items
          } catch {
            log(`  p${p} attempt ${attempt}: products answered non-JSON (status=${r.status()} ct=${r.headers()["content-type"] ?? "?"} body=${JSON.stringify(text.slice(0, 120).replace(/\s+/g, " "))})`)
            return null
          }
        })
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
    return items
  }

  // Leave the previous target's SPA state behind before the first page of this one.
  await page.goto("about:blank").catch(() => {})

  for (let p = 1; p <= maxPages; p++) {
    let items = await readPage(p)
    if (items == null) {
      error = `page ${p}: no readable products response after ${MAX_PAGE_ATTEMPTS} attempts`
      break
    }
    if (items.length === 0) {
      // ⚠ AN EMPTY ANSWER IS THE ONLY END-OF-LIST SIGNAL, AND IT RETIRES LISTINGS, so it
      // is CONFIRMED before it is believed. Measured 2026-09-24 from a datacenter IP: the
      // Hawks and Jazz both answered page 1 with an EMPTY list in one run and with 30
      // listings minutes later — an empty answer that, unconfirmed, would have "completed"
      // the walk and retired every listing the team had. Wait, drop the SPA state, re-read.
      log(`  p${p}: empty — confirming after ${EMPTY_CONFIRM_WAIT_MS / 1000}s`)
      await page.waitForTimeout(EMPTY_CONFIRM_WAIT_MS)
      await page.goto("about:blank").catch(() => {})
      const again = await readPage(p)
      if (again == null) {
        error = `page ${p}: answered empty, then no readable products response when re-read`
        break
      }
      if (again.length > 0) {
        log(`  p${p}: re-read returned ${again.length} items — the empty answer was not the end`)
        items = again
      }
    }
    if (items.length === 0) {
      pages = p
      complete = true
      break
    }
    const foreign = foreignTeamItems(items, target.team)
    if (foreign.length) {
      // The team filter did not hold (an unknown team string, or Panini changed the
      // parameter). Stop before writing anything from this page: an unfiltered grid is
      // 4,800 pages of every team, and ingesting it under this walk_team would be wrong.
      error = `page ${p}: grid did not honour the team filter (${foreign.length}/${items.length} items for other teams, e.g. ${JSON.stringify(foreign[0].team ?? null)})`
      break
    }
    pages = p
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

/** Receiver plan rows -> targets, keeping only sports this walker supports. */
export function planToTargets(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (r.sport === "Basketball" || r.sport === "Baseball") && typeof r.team === "string" && r.team.trim())
    .map((r) => ({ sport: r.sport, team: r.team.trim() }))
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
  const rotation = Number(process.env.PANINI_TEAM_ROTATION || 0)
  const budgetMin = Number(process.env.PANINI_WALK_BUDGET_MIN || 100)
  const runStarted = Date.now()
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

  // Explicit PANINI_TEAM_TARGETS wins; otherwise rotation mode asks the receiver for the
  // N stalest roster teams (panini_team_walk_plan); otherwise the pilot default.
  let targets
  if (process.env.PANINI_TEAM_TARGETS) {
    targets = parseTargets(process.env.PANINI_TEAM_TARGETS)
  } else if (rotation > 0) {
    if (!url || !token) throw new Error("rotation mode needs RPC_PANINI_TEAM_WALK_URL / INGEST_SECRET_TOKEN")
    const plan = await post(url, token, { op: "plan", limit: rotation })
    if (!plan.ok || !Array.isArray(plan.data?.targets)) throw new Error(`plan failed (http ${plan.status}): ${plan.data?.error ?? "no targets"}`)
    targets = planToTargets(plan.data.targets)
    log(`rotation: ${targets.map((t) => `${t.sport}:${t.team}`).join(", ")}`)
  } else {
    targets = parseTargets(DEFAULT_TARGETS)
  }

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
      // Do not START a team past the budget — the task shares the laptop with the soccer
      // runner's next slot. An unstarted team is not a failure; it heads the next plan.
      const elapsedMin = (Date.now() - runStarted) / 60_000
      if (elapsedMin > budgetMin) {
        log(`budget: ${Math.round(elapsedMin)} min > PANINI_WALK_BUDGET_MIN=${budgetMin}; not starting ${target.sport}:${target.team}`)
        summary.push({ target: `${target.sport}:${target.team}`, skipped: "budget" })
        continue
      }
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
          if (r.data?.retire_skipped === true) {
            // The DB would not retire: this "complete" walk saw fewer than half of the
            // team's active listings — a false end-of-list is far likelier than half a
            // team's market vanishing. Not a failed write, but not a trustworthy walk.
            writeErrors.push(`retirement refused: saw ${r.data?.seen} of ${r.data?.active_before} active listings`)
          }
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
    // Over CDP, browser.close() DISCONNECTS and leaves the runner's debug Chrome open
    // (same call as ingest-panini-runner.mjs). Skipping it left the CDP websocket holding
    // node alive: the first laptop run finished its writes at 3:22 PM PT and then idled
    // until Task Scheduler's 2 h limit killed the whole task (LastTaskResult 267014).
    await browser.close().catch(() => {})
  }
  if (dry) console.log(JSON.stringify({ dry_run: true, summary }, null, 2))
  if (!dry && !anyFailed && stampFile) fs.writeFileSync(stampFile, today)
  if (anyFailed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Exit explicitly: a lingering handle must never turn a finished walk into a task the
  // scheduler kills (which also swallows panini-run.bat's "run end" line).
  main().then(() => process.exit(process.exitCode ?? 0), (e) => {
    console.error("[panini-team-walk] fatal:", e instanceof Error ? e.stack : e)
    process.exit(2)
  })
}
