#!/usr/bin/env node
// scripts/panini-collector-walk.mjs — read linked collectors' PUBLIC Panini profiles (2026-09-27).
//
// WHY. The Panini Collection tab could only show cards RPC had SEEN under a username, and RPC
// learns a holder only from a LISTING: Trevor's profile shows 146 NFTs + 12 unopened packs and
// RPC had seen 0. Panini publishes every collector's cards on a public profile page — its own
// "View your collection" link is /@<u>/profile/collections.html (route constant rP, Panini's
// bundle 2026-09-27; Trevor's profile link is the /@<u>/profile/panini-wall.html sibling) —
// whose SPA asks its own GraphQL `userCollectedNftsV2(p, l:30, …, nickname)` — 30 cards a page,
// the next page on SCROLL (measured in Panini's bundle 2026-09-27: the page appends while the
// last answer carried ≥ 30 products) — each product with url_key (= panini_card_serials.sku),
// psku, athlete, cardset, sport_name, image_url, start_seq/end_seq, plus total_size.
//
// ⚠ WHY THE RESPONSE AND NOT A REPLAY. Panini signs every /onepanini request. The page builds
// and signs its own queries; page.on("response") reads the answers at the network layer. RPC
// never forges, stores or replays a signature.
//
// ⚠ COMPLETE = every card the profile reported. A walk that collected fewer distinct cards than
// total_size, or never learned total_size, is posted INCOMPLETE: the DB then only adds (it
// retires cards that left a profile only on a walk it also judges complete).
//
// ⚠ WHO IS WALKED. Usernames users LINKED to their RPC profile (the receiver's `plan`, opt-in),
// plus PANINI_COLLECTOR_TARGETS set on this box by its owner. Never a name typed on the site.
//
// Env:
//   RPC_PANINI_COLLECTOR_WALK_URL  https://www.rippackscity.com/api/cron/panini-collector-walk
//   INGEST_SECRET_TOKEN            bearer for that route           (neither needed with DRY_RUN=1)
//   PANINI_CDP_URL                 optional: drive an existing Chrome (the runner's debug profile)
//   PANINI_COLLECTOR_TARGETS       optional explicit usernames, comma/semicolon separated
//   PANINI_COLLECTOR_PLAN          N linked usernames to ask the receiver for, default 25 (0 = none)
//   PANINI_COLLECTOR_MAX_PAGES     per username, default 200 (30 cards a page)
//   DRY_RUN=1                      walk and report, write nothing
//   CHROMIUM_PATH                  optional executablePath when launching (no CDP)

import { pathToFileURL } from "node:url"

export const PROFILE_BASE = "https://nft.paniniamerica.net/public-profile/collections.html"
export const PAGE_SIZE = 30
const USERNAME = /^[A-Za-z0-9_.-]{2,16}$/

export function profileUrl(nickname) {
  const q = new URLSearchParams({ nickname, tab: "collected" })
  return `${PROFILE_BASE}?${q.toString()}`
}

/**
 * The pages to try, in order, until one answers with this collector's cards. Panini serves the
 * collection under two route families (both in its bundle); which one pages the collected list
 * for a signed-out-or-other viewer was not measurable from RPC's side, so the walker tries both
 * and logs which one answered.
 */
export function profileUrlCandidates(nickname) {
  const at = `https://nft.paniniamerica.net/@${encodeURIComponent(nickname)}/profile/collections.html`
  return [`${at}?tab=collected`, profileUrl(nickname), at]
}

export const UNOPENED_PACKS_URL = (nickname) => `https://nft.paniniamerica.net/@${encodeURIComponent(nickname)}/profile/unopened-packs.html`

/**
 * Does this request ask about `nickname`? ⛔ One of Panini's collection components falls back to
 * the SIGNED-IN user when the URL names nobody, and the runner's Chrome may be signed in — so an
 * answer is attributed to a username only when its own request names that username (the
 * `nickname:` argument, or `nickname=` / `full_name=` in the filters it forwards).
 */
export function answerIsFor(postData, nickname) {
  let q = ""
  try {
    const b = JSON.parse(postData || "{}")
    q = typeof b.query === "string" ? b.query : ""
    if (b.variables && typeof b.variables === "object") q += " " + JSON.stringify(b.variables)
  } catch {
    return false
  }
  const want = String(nickname).toLowerCase()
  for (const m of q.matchAll(/(?:nickname|full_name)\\?"?\s*[:=]\s*\\?"?([A-Za-z0-9_.%-]+)/gi)) {
    let v = m[1]
    try {
      v = decodeURIComponent(v)
    } catch {
      // keep the raw value
    }
    if (v.toLowerCase() === want) return true
  }
  return false
}

/** "a, b;c" -> ["a","b","c"] (valid usernames, first spelling of each folded name kept). */
export function parseTargets(raw) {
  const out = []
  const seen = new Set()
  for (const part of String(raw || "").split(/[;,\s]+/).map((s) => s.trim().replace(/^@/, "")).filter(Boolean)) {
    if (!USERNAME.test(part)) throw new Error(`bad PANINI_COLLECTOR_TARGETS entry: "${part}" (2–16 letters, numbers, . _ -)`)
    const k = part.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(part)
    }
  }
  return out
}

/** Merge explicit targets with the receiver's plan rows, deduped on the folded name. */
export function mergeTargets(explicit, planRows) {
  const out = [...explicit]
  const seen = new Set(explicit.map((t) => t.toLowerCase()))
  for (const r of Array.isArray(planRows) ? planRows : []) {
    const nick = typeof r?.nickname === "string" ? r.nickname.trim() : ""
    if (!USERNAME.test(nick) || seen.has(nick.toLowerCase())) continue
    seen.add(nick.toLowerCase())
    out.push(nick)
  }
  return out
}

/** The GraphQL operation a /onepanini request carries, or null. */
export function operationOf(url, postData) {
  if (!String(url).includes("/onepanini")) return null
  try {
    const b = JSON.parse(postData || "{}")
    if (typeof b.operationName === "string" && b.operationName) return b.operationName
    const m = typeof b.query === "string" ? /^\s*(?:query|mutation)\s+(\w+)/.exec(b.query) : null
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Depth-first search for the first value under `key` anywhere in a JSON value. */
export function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return undefined
  if (!Array.isArray(obj) && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const got = findKey(v, key, depth + 1)
    if (got !== undefined) return got
  }
  return undefined
}

const int = (v) => {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : null
}
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

/**
 * One profile product -> the holding the receiver takes, or null. The serial and cap come from
 * url_key's own "<psku>__<serial>_<cap>" suffix (the marketplace grid's sku shape) when present,
 * else start_seq/end_seq.
 */
export function toHolding(p) {
  if (!p || typeof p !== "object") return null
  const urlKey = str(p.url_key, 200) ?? str(p.sku, 200)
  if (!urlKey) return null
  const m = /^(.+)__(\d+)_(\d+)$/.exec(urlKey)
  return {
    url_key: urlKey,
    psku: str(p.psku, 200) ?? (m ? m[1] : null),
    serial_number: m ? int(m[2]) : int(p.start_seq),
    mint_cap: m ? int(m[3]) : int(p.end_seq),
    athlete: str(p.athlete, 200),
    cardset: str(p.cardset, 200),
    sport: str(p.sport_name, 40),
    image_url: str(p.image_url, 500),
  }
}

/** Read the collected-cards answer: { products, total } (either may be null when unreadable). */
export function readCollected(json) {
  const node = json?.data?.userCollectedNftsV2
  const data = node?.data
  const products = Array.isArray(data?.products) ? data.products : null
  const total = int(data?.total_size)
  return { products, total, status: node?.status ?? null, message: typeof node?.message === "string" ? node.message : null }
}

/** What the profile said about itself: public / private / not_found / unknown. */
export function profileStateOf({ url, profileInfo, collectedSeen }) {
  if (/\/usernotfound/i.test(String(url || ""))) return "not_found"
  const exists = findKey(profileInfo, "userExists")
  if (exists === false || exists === 0 || exists === "false") return "not_found"
  const vis = findKey(profileInfo, "profile_visibility")
  if (typeof vis === "string" && /private|hidden/i.test(vis)) return "private"
  if (vis === false || vis === 0) return "private"
  return collectedSeen ? "public" : "unknown"
}

/** Is the walk complete? Only with a known total and at least that many distinct cards. */
export function isComplete(distinct, total, error) {
  return error == null && total != null && distinct >= total
}

async function walkProfile(ctx, nickname, { maxPages, log }) {
  const page = await ctx.newPage()
  const holdings = new Map()
  let total = null
  let unopenedPacks = null
  let profileInfo = null
  let collectedSeen = false
  let answers = 0
  let lastLen = null
  let error = null
  let sampleKeys = null
  let waiter = null
  let foreign = 0
  let source = null

  page.on("response", async (r) => {
    const op = operationOf(r.url(), r.request().postData())
    if (!op) return
    let json = null
    try {
      json = JSON.parse(await r.text())
    } catch {
      if (op === "userCollectedNftsV2") log(`  ${nickname}: userCollectedNftsV2 answered non-JSON (status=${r.status()})`)
      return
    }
    if ((op === "userCollectedNftsV2" || op === "UnopenedPacksStats") && !answerIsFor(r.request().postData(), nickname)) {
      foreign += 1
      if (foreign <= 3) log(`  ${nickname}: ignored a ${op} answer whose request does not name ${nickname}`)
      return
    }
    if (op === "userCollectedNftsV2") {
      const got = readCollected(json)
      if (!got.products) {
        log(`  ${nickname}: userCollectedNftsV2 without products (status=${JSON.stringify(got.status)} message=${JSON.stringify(got.message)})`)
        if (waiter) waiter(null)
        return
      }
      collectedSeen = true
      answers += 1
      lastLen = got.products.length
      if (got.total != null) total = got.total
      if (!sampleKeys && got.products[0]) sampleKeys = Object.keys(got.products[0]).sort().join(",")
      for (const p of got.products) {
        const h = toHolding(p)
        if (h && !holdings.has(h.url_key)) holdings.set(h.url_key, h)
      }
      if (waiter) waiter(got.products.length)
    } else if (op === "UnopenedPacksStats" || op === "unopenedPackStats") {
      const n = int(findKey(json, "unopenedpacks_total_count"))
      if (n != null) unopenedPacks = n
    } else if (op === "bcProfileInfo" || op === "profileInfo") {
      profileInfo = json
    }
  })

  const nextAnswer = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        waiter = null
        resolve(undefined)
      }, ms)
      waiter = (v) => {
        clearTimeout(t)
        waiter = null
        resolve(v)
      }
    })

  let finalUrl = ""
  try {
    let got
    for (const candidate of profileUrlCandidates(nickname)) {
      const first = nextAnswer(45_000)
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
        log(`  ${nickname}: goto failed (${e.message.split("\n")[0]})`)
      })
      got = await first
      if (got !== undefined && got !== null) {
        source = candidate
        log(`  ${nickname}: collected cards answered on ${candidate}`)
        break
      }
      log(`  ${nickname}: no collected-cards answer for ${nickname} on ${candidate} (landed on ${page.url()})`)
      if (/\/usernotfound/i.test(page.url())) break
    }
    if (got === undefined || got === null) {
      const title = await page.title().catch(() => "?")
      const body = await page.evaluate(() => (document.body?.innerText || "").slice(0, 160)).catch(() => "?")
      error = `no collected-cards answer (url=${page.url()} title=${JSON.stringify(title)} body=${JSON.stringify(String(body).replace(/\s+/g, " "))})`
    } else {
      // Scroll for the next page while the last answer was a full page and cards are missing.
      let pages = 1
      while (lastLen != null && lastLen >= PAGE_SIZE && (total == null || holdings.size < total)) {
        if (pages >= maxPages) {
          error = `hit PANINI_COLLECTOR_MAX_PAGES=${maxPages}`
          break
        }
        let n
        for (let attempt = 1; attempt <= 4 && n === undefined; attempt++) {
          const next = nextAnswer(attempt === 1 ? 15_000 : 25_000)
          await page.evaluate(() => window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - 1600))).catch(() => {})
          await page.waitForTimeout(300)
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {})
          n = await next
          if (n === undefined) log(`  ${nickname}: no next page after scroll attempt ${attempt} (${holdings.size}/${total ?? "?"})`)
        }
        if (n === undefined || n === null) {
          error = `stopped at ${holdings.size}/${total ?? "?"} cards: the next page never answered`
          break
        }
        pages += 1
        await page.waitForTimeout(800)
      }
      // Give the profile header's own reads (packs, profile info) a moment if they have not landed.
      if (unopenedPacks == null || profileInfo == null) await page.waitForTimeout(3_000)
      if (unopenedPacks == null) {
        // The Unopened Packs tab asks UnopenedPacksStats(nickname) for itself.
        await page.goto(UNOPENED_PACKS_URL(nickname), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
        for (let i = 0; i < 20 && unopenedPacks == null; i++) await page.waitForTimeout(1_000)
        if (unopenedPacks == null) log(`  ${nickname}: unopened-pack count not read (kept as unknown)`)
      }
    }
  } finally {
    finalUrl = page.url()
    await page.close().catch(() => {})
  }
  const profileState = profileStateOf({ url: finalUrl, profileInfo, collectedSeen })
  if (!error && total != null && holdings.size < total) error = `collected ${holdings.size} of ${total} cards`
  return { holdings: [...holdings.values()], total, unopenedPacks, profileState, answers, error, sampleKeys, source, foreign }
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
  const dry = process.env.DRY_RUN === "1"
  const url = process.env.RPC_PANINI_COLLECTOR_WALK_URL
  const token = process.env.INGEST_SECRET_TOKEN
  const planN = Number(process.env.PANINI_COLLECTOR_PLAN ?? 25)
  const maxPages = Number(process.env.PANINI_COLLECTOR_MAX_PAGES || 200)
  const log = (...a) => console.log("[panini-collector-walk]", ...a)
  if (!dry && (!url || !token)) throw new Error("RPC_PANINI_COLLECTOR_WALK_URL / INGEST_SECRET_TOKEN missing (or set DRY_RUN=1)")

  const explicit = parseTargets(process.env.PANINI_COLLECTOR_TARGETS || "")
  let planRows = []
  if (planN > 0 && url && token) {
    const plan = await post(url, token, { op: "plan", limit: Math.min(planN, 50) })
    if (plan.ok && Array.isArray(plan.data?.targets)) planRows = plan.data.targets
    else log(`plan failed (http ${plan.status}): ${plan.data?.error ?? "no targets"} — walking the explicit list only`)
  }
  const targets = mergeTargets(explicit, planRows)
  if (targets.length === 0) {
    log("no targets (nobody has linked a Panini username, and PANINI_COLLECTOR_TARGETS is empty)")
    return
  }
  log(`targets: ${targets.join(", ")}`)

  const { chromium } = await import("playwright")
  const cdp = process.env.PANINI_CDP_URL
  const browser = cdp
    ? await chromium.connectOverCDP(cdp, { timeout: 30_000 })
    : await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const ctx = cdp ? browser.contexts()[0] ?? (await browser.newContext()) : await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const summary = []
  let anyFailed = false
  try {
    for (const nickname of targets) {
      const walkStartedAt = new Date().toISOString()
      if (!dry) {
        const hb = await post(url, token, { op: "heartbeat", username: nickname, walk_started_at: walkStartedAt })
        if (!hb.ok) log(`heartbeat not recorded (http ${hb.status})`)
      }
      log(`walking ${nickname}`)
      const res = await walkProfile(ctx, nickname, { maxPages, log })
      const complete = isComplete(res.holdings.length, res.total, res.error)
      const line = {
        username: nickname,
        profile_state: res.profileState,
        reported_total: res.total,
        cards_collected: res.holdings.length,
        unopened_packs: res.unopenedPacks,
        answers: res.answers,
        source: res.source,
        ignored_foreign_answers: res.foreign,
        complete,
        error: res.error,
        product_fields: res.sampleKeys,
      }
      if (!dry) {
        const r = await post(url, token, {
          op: "ingest",
          username: nickname,
          walk_started_at: walkStartedAt,
          complete,
          profile_state: res.profileState,
          reported_total: res.total,
          unopened_packs: res.unopenedPacks,
          error: res.error,
          holdings: res.holdings,
          extra: { answers: res.answers, source: res.source, ignored_foreign_answers: res.foreign },
        })
        if (!r.ok || typeof r.data?.written !== "number") {
          line.write_error = `ingest http ${r.status}: ${r.data?.error ?? r.data?.message ?? "no write count"}`
          anyFailed = true
        } else {
          Object.assign(line, { written: r.data.written, retired: r.data.retired, db_complete: r.data.complete })
        }
      } else {
        line.sample = res.holdings.slice(0, 3)
      }
      if (!complete) anyFailed = true
      summary.push(line)
      log(JSON.stringify(line))
    }
  } finally {
    // Over CDP, browser.close() DISCONNECTS and leaves the runner's debug Chrome open.
    await browser.close().catch(() => {})
  }
  if (dry) console.log(JSON.stringify({ dry_run: true, summary }, null, 2))
  if (anyFailed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then(() => process.exit(process.exitCode ?? 0), (e) => {
    console.error("[panini-collector-walk] fatal:", e instanceof Error ? e.stack : e)
    process.exit(2)
  })
}
