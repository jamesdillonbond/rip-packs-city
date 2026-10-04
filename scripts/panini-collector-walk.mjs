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
// ⚠ PER COLLECTION (measured live 2026-09-27, first run). The profile page no longer pages the
// cards: it opens in Collection View and asks only collectionList (one row per collection with
// collected_count — Trevor's 24 rows sum to exactly the 146 his header shows). So the walk reads
// that list, then opens each collection's collection-details page, which DOES page
// userCollectedNftsV2 on scroll. The reported total is the sum of collected_count, known only
// when every collection row was read.
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
// plus PANINI_COLLECTOR_TARGETS set on this box by its owner, plus (PANINI_COLLECTOR_ROTATION)
// a few of the Panini owners who are also Top Shot usernames RPC knows, which Trevor chose to
// walk on 2026-09-28. Never a name typed on the site.
//
// Env:
//   RPC_PANINI_COLLECTOR_WALK_URL  https://www.rippackscity.com/api/cron/panini-collector-walk
//   INGEST_SECRET_TOKEN            bearer for that route           (neither needed with DRY_RUN=1)
//   PANINI_CDP_URL                 optional: drive an existing Chrome (the runner's debug profile)
//   PANINI_COLLECTOR_TARGETS       optional explicit usernames, comma/semicolon separated
//   PANINI_COLLECTOR_PLAN          N linked usernames to ask the receiver for, default 25 (0 = none)
//   PANINI_COLLECTOR_ROTATION      N rotation names to ask for — Panini owners who are also Top Shot
//                                  usernames, least-recently-walked first — default 0 (none)
//   PANINI_COLLECTOR_BUDGET_MIN    stop STARTING new walks after this many minutes (the walk in
//                                  progress finishes); unset = no budget, the watchdog alone
//   PANINI_COLLECTOR_WALK_MAX_MIN  per-username cap: past it the walk stops reading, posts what it
//                                  read as INCOMPLETE (adds, retires nothing) and the run moves on;
//                                  unset = no cap
//   PANINI_COLLECTOR_MAX_PAGES     per collection, default 200 (30 cards a page)
//   PANINI_COLLECTOR_HARD_MIN      watchdog: exit 3 after this many minutes, default 30
//   DRY_RUN=1                      walk and report, write nothing
//   CHROMIUM_PATH                  optional executablePath when launching (no CDP)

import { pathToFileURL } from "node:url"
import { TIMED_OUT, sleep, withDeadline } from "./lib/with-deadline.mjs"

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
 * One collection's card page, built the way Panini's own Collection View links it (measured
 * 2026-09-27). ⚠ WHY PER COLLECTION. The profile page now opens in "Collection View": it asks
 * collectionList (one row per collection, with collected_count) and never pages the collected
 * cards itself; its "All Cards View" toggle is disabled, and forcing it
 * (?all_card_collection_view) answers userCollectedNftsV2 with products:[] even for the
 * signed-in owner. Each collection-details page DOES page userCollectedNftsV2 (30 a page, next
 * on scroll), with nickname= and full_name= in the filters it forwards.
 */
export function collectionDetailsUrl(nickname, c) {
  const q = [
    ["sport", c.sport],
    ["year", String(c.year)],
    ["cname", c.cname],
    ["tab", "collected"],
    ["nickname", nickname],
    ["show_collected", "true"],
    ["sortBy", "new"],
  ]
  return `https://nft.paniniamerica.net/collection-details?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`
}

/**
 * Read a collectionList answer: { collections, total } where total is the NUMBER OF COLLECTIONS
 * the profile reported (not cards) and each collection carries its own collected card count.
 * A row without a name, year, sport or a readable count makes the whole answer unreadable (null):
 * a card total summed over a row that could not be read would be a made-up total.
 */
export function readCollectionList(json) {
  const data = json?.data?.collectionList?.data
  if (!data || !Array.isArray(data.collections)) return { collections: null, total: null }
  const collections = []
  for (const c of data.collections) {
    const cname = str(c?.cname, 200)
    const sport = str(c?.sport_name, 40)
    const year = int(c?.year)
    const count = int(c?.collected_count)
    if (!cname || !sport || year == null || count == null) return { collections: null, total: null }
    collections.push({ cname, sport, year, count })
  }
  return { collections, total: int(data.total_size) }
}

/** The SIGNED-IN account's Panini nickname (profileInfo's blockchain_name attribute), or null. */
export function signedInNickname(json) {
  const attrs = json?.data?.profileInfo?.custom_attributes
  if (!Array.isArray(attrs)) return null
  return str(attrs.find((a) => a?.attribute_code === "blockchain_name")?.value, 64)
}

/**
 * Unopened packs from a clubSimilarPacks answer (the Unopened Packs tab, measured 2026-09-27):
 * the sum of pack_count over its rows, or null unless every row arrived (rows >= total_count).
 * ⛔ Its request names NO user — it answers for the SIGNED-IN viewer — so the walk credits it to
 * a username only when that username IS the signed-in account (signedInNickname).
 */
export function readClubPacks(json) {
  const node = json?.data?.clubSimilarPacks
  const rows = Array.isArray(node?.data) ? node.data : null
  const total = int(node?.total_count)
  if (!rows || total == null || rows.length < total) return null
  let sum = 0
  for (const r of rows) {
    const n = int(r?.pack_count)
    if (n == null) return null
    sum += n
  }
  return sum
}

/** Cards the profile reports, summed over its collections — known only once EVERY collection was read. */
export function reportedCardTotal(collections, collectionTotal) {
  if (!Array.isArray(collections) || collectionTotal == null || collections.length < collectionTotal) return null
  return collections.reduce((s, c) => s + c.count, 0)
}

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

/**
 * May another walk START? A walk runs to the end once started (a half walk is posted incomplete
 * and retires nothing), so the budget only stops new ones — keep it a walk's length under the
 * watchdog. No budget (null / non-positive / NaN) always answers yes.
 */
export function mayStartWalk(startedMs, nowMs, budgetMin) {
  if (!(Number(budgetMin) > 0)) return true
  return nowMs - startedMs < Number(budgetMin) * 60_000
}

/**
 * Past a walk's own deadline? A profile too big for one night (2026-09-29: scottyj111's walk ran
 * into the 55-min watchdog, which lost everything it had read AND every name after it) stops at
 * the cap and posts a partial read instead. No cap (null / non-positive / NaN) is never past.
 */
export function pastWalkCap(walkStartedMs, nowMs, capMin) {
  if (!(Number(capMin) > 0)) return false
  return nowMs - walkStartedMs >= Number(capMin) * 60_000
}

/**
 * The order a walk reads a profile's collections in: the list rotated to start at a day-dependent
 * index. A profile too big for the cap (2026-10-03: 30 of 128, 28 of 65, 4 of 54) used to restart
 * at collection 0 every walk, so everything past the cap was NEVER read. Rotating the start by day
 * makes successive capped walks cover different collections; a profile that finishes reads them
 * all either way, and partial reads only ever add holdings.
 */
export function walkOrder(collections, dayIndex) {
  const n = collections.length
  if (n === 0) return []
  const d = Number.isFinite(dayIndex) ? Math.trunc(dayIndex) : 0
  // 7919 is prime, so consecutive days land far apart in any list shorter than it.
  const start = (((d * 7919) % n) + n) % n
  return [...collections.slice(start), ...collections.slice(0, start)]
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

async function walkProfile(ctx, nickname, { maxPages, log, capMin = null }) {
  const walkStartedMs = Date.now()
  const capped = () => pastWalkCap(walkStartedMs, Date.now(), capMin)
  let capHit = null
  const page = await ctx.newPage()
  const holdings = new Map()
  let collections = null
  let collectionTotal = null
  let lastListLen = null
  let unopenedPacks = null
  let profileInfo = null
  let signedIn = null
  let clubPacks
  let collectedSeen = false
  let answers = 0
  let lastLen = null
  let sampleKeys = null
  const waiters = { list: null, cards: null }
  let foreign = 0
  let source = null
  const shortfalls = []
  let error = null

  page.on("response", async (r) => {
    const op = operationOf(r.url(), r.request().postData())
    if (!op) return
    let json = null
    try {
      const text = await withDeadline(r.text(), 30_000)
      if (text === TIMED_OUT) throw new Error("body not readable in 30s")
      json = JSON.parse(text)
    } catch {
      if (op === "userCollectedNftsV2" || op === "collectionList") log(`  ${nickname}: ${op} answered non-JSON (status=${r.status()})`)
      return
    }
    if ((op === "userCollectedNftsV2" || op === "collectionList" || op === "UnopenedPacksStats") && !answerIsFor(r.request().postData(), nickname)) {
      foreign += 1
      if (foreign <= 3) log(`  ${nickname}: ignored a ${op} answer whose request does not name ${nickname}`)
      return
    }
    if (op === "collectionList") {
      const got = readCollectionList(json)
      if (!got.collections) {
        log(`  ${nickname}: collectionList unreadable (${JSON.stringify(json).slice(0, 200)})`)
        if (waiters.list) waiters.list(null)
        return
      }
      collections ??= []
      const seen = new Set(collections.map((c) => `${c.sport}|${c.year}|${c.cname}`))
      for (const c of got.collections) if (!seen.has(`${c.sport}|${c.year}|${c.cname}`)) collections.push(c)
      if (got.total != null) collectionTotal = got.total
      lastListLen = got.collections.length
      if (waiters.list) waiters.list(got.collections.length)
    } else if (op === "userCollectedNftsV2") {
      const got = readCollected(json)
      if (!got.products) {
        log(`  ${nickname}: userCollectedNftsV2 without products (status=${JSON.stringify(got.status)} message=${JSON.stringify(got.message)})`)
        if (waiters.cards) waiters.cards(null)
        return
      }
      collectedSeen = true
      answers += 1
      lastLen = got.products.length
      if (!sampleKeys && got.products[0]) sampleKeys = Object.keys(got.products[0]).sort().join(",")
      for (const p of got.products) {
        const h = toHolding(p)
        if (h && !holdings.has(h.url_key)) holdings.set(h.url_key, h)
      }
      if (waiters.cards) waiters.cards(got.products.length)
    } else if (op === "UnopenedPacksStats" || op === "unopenedPackStats") {
      const n = int(findKey(json, "unopenedpacks_total_count"))
      if (n != null) unopenedPacks = n
    } else if (op === "clubSimilarPacks") {
      clubPacks = readClubPacks(json)
    } else if (op === "profileInfo") {
      signedIn = signedInNickname(json) ?? signedIn
      if (!profileInfo) profileInfo = json
    } else if (op === "bcProfileInfo") {
      profileInfo = json
    }
  })

  const nextAnswer = (kind, ms) =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        waiters[kind] = null
        resolve(undefined)
      }, ms)
      waiters[kind] = (v) => {
        clearTimeout(t)
        waiters[kind] = null
        resolve(v)
      }
    })

  const scrollForNext = async (kind) => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const next = nextAnswer(kind, attempt === 1 ? 15_000 : 25_000)
      await withDeadline(page.evaluate(() => window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - 1600))).catch(() => {}), 10_000)
      await sleep(300)
      await withDeadline(page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)).catch(() => {}), 10_000)
      const n = await next
      if (n !== undefined) return n
    }
    return undefined
  }

  let finalUrl = ""
  try {
    // 1. The profile's collection list: one row per collection, each with its collected count.
    let got
    for (const candidate of profileUrlCandidates(nickname)) {
      const first = nextAnswer("list", 45_000)
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
        log(`  ${nickname}: goto failed (${e.message.split("\n")[0]})`)
      })
      got = await first
      if (got !== undefined && got !== null) {
        source = candidate
        log(`  ${nickname}: collection list answered on ${candidate}`)
        break
      }
      log(`  ${nickname}: no collection list for ${nickname} on ${candidate} (landed on ${page.url()})`)
      if (/\/usernotfound/i.test(page.url())) break
    }
    if (got === undefined || got === null) {
      const title = await withDeadline(page.title().catch(() => "?"), 10_000).then((v) => (v === TIMED_OUT ? "(tab not answering)" : v))
      const body = await withDeadline(page.evaluate(() => (document.body?.innerText || "").slice(0, 160)).catch(() => "?"), 10_000).then((v) => (v === TIMED_OUT ? "(tab not answering)" : v))
      error = `no collection list (url=${page.url()} title=${JSON.stringify(title)} body=${JSON.stringify(String(body).replace(/\s+/g, " "))})`
    } else {
      while (lastListLen != null && lastListLen >= PAGE_SIZE && (collectionTotal == null || collections.length < collectionTotal)) {
        const n = await scrollForNext("list")
        if (n === undefined || n === null) break
      }
      const reported = reportedCardTotal(collections, collectionTotal)
      log(`  ${nickname}: ${collections.length}/${collectionTotal ?? "?"} collections, ${reported ?? "?"} cards reported`)
      if (reported == null) error = `read ${collections.length} of ${collectionTotal ?? "?"} collections`

      // 2. Each collection's own card pages.
      for (const [ci, c] of walkOrder(collections, Math.floor(Date.now() / 86_400_000)).entries()) {
        if (c.count === 0) continue
        if (capped()) {
          capHit = `per-walk cap of ${capMin} min reached after ${ci} of ${collections.length} collections`
          log(`  ${nickname}: ${capHit} — posting a partial read`)
          break
        }
        const before = holdings.size
        let pages = 0
        // A collection that comes up short is loaded once more (a slow first answer missed the
        // 45 s wait on 2026-09-27 and answered on the next load).
        for (let load = 1; load <= 2 && holdings.size - before < c.count; load++) {
          lastLen = null
          const first = nextAnswer("cards", 45_000)
          await page.goto(collectionDetailsUrl(nickname, c), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => {
            log(`  ${nickname}: ${c.cname}: goto failed (${e.message.split("\n")[0]})`)
          })
          let n = await first
          pages = n === undefined || n === null ? 0 : 1
          while (n !== undefined && n !== null && lastLen >= PAGE_SIZE && holdings.size - before < c.count) {
            if (pages >= maxPages || capped()) break
            n = await scrollForNext("cards")
            if (n !== undefined && n !== null) pages += 1
            await sleep(500)
          }
        }
        const read = holdings.size - before
        log(`  ${nickname}: ${c.cname} (${c.year} ${c.sport}): ${read}/${c.count} cards, ${pages} page(s)`)
        if (read < c.count) shortfalls.push(`${c.cname} ${read}/${c.count}`)
      }
      if (capHit) error = [error, capHit].filter(Boolean).join("; ")
      if (shortfalls.length) error = [error, `short in ${shortfalls.length} collection(s): ${shortfalls.slice(0, 5).join("; ")}`].filter(Boolean).join("; ")

      // 3. Unopened packs. The tab asks clubSimilarPacks, which answers for the SIGNED-IN viewer
      //    and names nobody — so it counts only when this username IS the signed-in account.
      if (unopenedPacks == null && !capHit) {
        clubPacks = undefined
        await page.goto(UNOPENED_PACKS_URL(nickname), { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {})
        for (let i = 0; i < 30 && unopenedPacks == null && clubPacks === undefined; i++) await sleep(1_000)
        const self = signedIn != null && signedIn.toLowerCase() === nickname.toLowerCase()
        if (unopenedPacks == null && self && clubPacks != null) unopenedPacks = clubPacks
        if (unopenedPacks == null) {
          const why = !self ? `signed in as ${signedIn ?? "?"}, not ${nickname}` : clubPacks === undefined ? "no answer" : "answer unreadable or partial"
          log(`  ${nickname}: unopened-pack count not read (${why}; kept as unknown)`)
        }
      }
    }
  } finally {
    finalUrl = page.url()
    await withDeadline(page.close().catch(() => {}), 10_000)
  }
  const total = reportedCardTotal(collections, collectionTotal)
  const profileState = profileStateOf({ url: finalUrl, profileInfo, collectedSeen: collectedSeen || (collections != null && collections.length === 0 && collectionTotal === 0) })
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
  const rotationN = Number(process.env.PANINI_COLLECTOR_ROTATION || 0)
  let rotationRows = []
  if (rotationN > 0 && url && token) {
    const rot = await post(url, token, { op: "rotation", limit: Math.min(rotationN, 50) })
    if (rot.ok && Array.isArray(rot.data?.targets)) rotationRows = rot.data.targets
    else log(`rotation failed (http ${rot.status}): ${rot.data?.error ?? "no targets"} — skipping the rotation tonight`)
  }
  // Explicit and linked names first: when the budget runs out, the rotation is what waits.
  const targets = mergeTargets(mergeTargets(explicit, planRows), rotationRows)
  const budgetMin = process.env.PANINI_COLLECTOR_BUDGET_MIN
  const runStartedMs = Date.now()
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
    for (const [i, nickname] of targets.entries()) {
      if (!mayStartWalk(runStartedMs, Date.now(), budgetMin)) {
        log(`budget of ${budgetMin} min reached — not starting: ${targets.slice(i).join(", ")} (the rotation picks them up next run)`)
        break
      }
      const walkStartedAt = new Date().toISOString()
      if (!dry) {
        const hb = await post(url, token, { op: "heartbeat", username: nickname, walk_started_at: walkStartedAt })
        if (!hb.ok) log(`heartbeat not recorded (http ${hb.status})`)
      }
      log(`walking ${nickname}`)
      const res = await walkProfile(ctx, nickname, { maxPages, log, capMin: process.env.PANINI_COLLECTOR_WALK_MAX_MIN })
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
    await withDeadline(browser.close().catch(() => {}), 15_000)
  }
  if (dry) console.log(JSON.stringify({ dry_run: true, summary }, null, 2))
  if (anyFailed) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Watchdog (same reason as panini-team-walk.mjs): a read that hangs must end the walk, logged,
  // not hold the team-walk task open. One username measured ~2–4 min on 2026-09-27/28.
  const hardMin = Number(process.env.PANINI_COLLECTOR_HARD_MIN || 30)
  setTimeout(() => {
    console.error(`[panini-collector-walk] WATCHDOG: still running after ${hardMin} min (PANINI_COLLECTOR_HARD_MIN) — a read hung; exiting 3`)
    process.exit(3)
  }, hardMin * 60_000).unref()
  main().then(() => process.exit(process.exitCode ?? 0), (e) => {
    console.error("[panini-collector-walk] fatal:", e instanceof Error ? e.stack : e)
    process.exit(2)
  })
}
