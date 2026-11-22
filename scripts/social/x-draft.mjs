#!/usr/bin/env node
// scripts/social/x-draft.mjs — the facts and a first-pass draft for the day's @RipPacksCity post.
//
// Reads ONLY RPC's public insight APIs (https://www.rippackscity.com/api/public/insights/*), so it
// needs no keys and runs anywhere Node 18+ runs — including a scheduled cloud session that fetches
// this file from raw.githubusercontent.com. The calendar it implements is docs/social/x-calendar.md;
// change the calendar there and here together.
//
//   node scripts/social/x-draft.mjs                 # today's slot (Pacific Time)
//   node scripts/social/x-draft.mjs --slot mon      # force a slot: mon tue wed thu fri sat sun
//   node scripts/social/x-draft.mjs --date 2026-11-09
//
// Prints one JSON object: { date_pt, slot, title, link, facts, draft, draft_len, intent_url,
// thread[], breaking[], warnings[], skip_reason }. thread[] appears when a list is too long for
// one post: every item is named across numbered posts (draft = post 1), never cut to "+N more". A slot with nothing honest to say sets skip_reason and,
// where the calendar has one, falls back to its alternate. The draft is a STARTING POINT — the
// human (or the scheduled session) edits wording; the numbers come from here.
//
// House rules enforced here (docs/social/x-calendar.md § House rules):
//   - FMV/pricing confidence is never shown; it is used only as an internal filter.
//   - "DUC" never appears; every amount is plain US dollars.
//   - Pinnacle assets are characters; UFC Strike is excluded (its market is closed).
//   - Collectors are never named or tagged.
//   - A collection with no sales in the window is left out, never posted as "$0".

const SITE = "https://www.rippackscity.com"
const API = `${SITE}/api/public/insights`
const TZ = "America/Los_Angeles"
const SLOTS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const EXCLUDED = new Set(["ufc_strike"])
const NAMES = {
  nba_top_shot: "Top Shot",
  nfl_all_day: "All Day",
  laliga_golazos: "Golazos",
  disney_pinnacle: "Pinnacle",
  panini_blockchain: "Panini",
  candy_mlb: "Candy MLB",
  ufc_strike: "UFC Strike",
}
// Friday rotates one board a week (ISO week number mod length). Every entry has a public API,
// a page with a summary_large_image card, and a live market behind it.
const FRIDAY_BOARDS = [
  "squeeze",
  "serial-premiums",
  "market-cap",
  "offer-spread",
  "underpriced-serials",
  "autographs",
  "first-mint",
  "set-completers",
  "trade-in",
]
const BIG_SALE_USD = 1000

// ---------- small helpers ----------
const args = process.argv.slice(2)
const arg = (k) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : null
}

function ptParts(d) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday.toLowerCase().slice(0, 3), hm: `${p.hour}:${p.minute}` }
}

function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
}

const usd = (n) =>
  n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 && n % 1 ? 2 : 0 })
const int = (n) => Number(n).toLocaleString("en-US")
const coll = (slug) => NAMES[slug] ?? slug
const decode = (s) =>
  String(s ?? "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

// X counts every URL as 23 characters and most wide/emoji characters as 2.
function xLength(text) {
  const noUrls = text.replace(/https?:\/\/\S+/g, () => "x".repeat(23))
  let n = 0
  for (const ch of noUrls) n += ch.codePointAt(0) >= 0x1100 ? 2 : 1
  return n
}
const intent = (text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`

async function getJson(path) {
  const r = await fetch(`${API}/${path}`, { headers: { "user-agent": "rpc-x-calendar/1.0" } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}
async function pageDescription(slug) {
  try {
    const r = await fetch(`${SITE}/insights/${slug}`, { headers: { "user-agent": "rpc-x-calendar/1.0" } })
    const html = await r.text()
    const m = html.match(/<meta property="og:description" content="([^"]*)"/)
    const t = html.match(/<meta property="og:title" content="([^"]*)"/)
    return { description: decode(m?.[1]), title: decode(t?.[1]) }
  } catch {
    return { description: null, title: null }
  }
}

function fit(lines, head, tail, max = 280) {
  // Drop list lines from the bottom until the post fits.
  let body = [...lines]
  while (body.length > 1 && xLength([head, ...body, tail].join("\n")) > max) body.pop()
  return [head, ...body, tail].join("\n")
}

// Every line, never "+N more": split the list across a numbered thread of posts that each fit.
// The first post opens with `head`, the last carries `tail` (the link); with more than one post each
// ends "i/n". A single line too long for any post still gets a post of its own (and a length warning).
function thread(lines, head, tail, max = 280) {
  const pack = (reserve) => {
    const posts = []
    let cur = [head]
    const fits = (arr) => xLength(arr.join("\n")) + reserve <= max
    for (const line of lines) {
      const empty = cur.length === 0 || (posts.length === 0 && cur.length === 1)
      if (!empty && !fits([...cur, line])) {
        posts.push(cur)
        cur = []
      }
      cur.push(line)
    }
    if (cur.length && !fits([...cur, tail])) {
      posts.push(cur)
      cur = []
    }
    posts.push([...cur, tail])
    return posts
  }
  let posts = pack(0)
  if (posts.length > 1) posts = pack("\n99/99".length)
  const n = posts.length
  return posts.map((p, i) => {
    const text = p.join("\n").trim()
    return n > 1 ? `${text}\n${i + 1}/${n}` : text
  })
}

// ---------- slots ----------
async function topSales7d() {
  const d = await getJson("top-sales?window=7d&sort=price&limit=200")
  return (d.rows ?? []).filter((r) => !EXCLUDED.has(r.collection) && r.price_usd > 0)
}

// A Dapper wallet's username from Disney Pinnacle's public GQL (one Dapper username per wallet across
// every Dapper app): the owner of any pin the wallet holds carries it. Used only when the insights API
// returned an address (11-09: the week's two Pinnacle sales went to 0x6de0…cade, which no RPC
// table had named). null when the wallet holds no Pinnacle pin or the call fails.
const DAPPER_GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
async function dapperUsername(addr) {
  const bare = String(addr ?? "").toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]{16}$/.test(bare)) return null
  try {
    const r = await fetch(DAPPER_GQL, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://disneypinnacle.com" },
      body: JSON.stringify({
        query: `query($a:String!){ searchPinnacleNft(searchInput:{first:1, filters:[{owner_address:{in:[$a]}}]}){ edges{ node{ user{ username } } } } }`,
        variables: { a: bare },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json()
    const u = j?.data?.searchPinnacleNft?.edges?.[0]?.node?.user?.username
    return typeof u === "string" && u.trim() ? u.trim() : null
  } catch {
    return null
  }
}
// A sale's buyer as the post names it: the marketplace username, never a wallet address. A buyer the
// API could only resolve to an address (it abbreviates those as 0x1234…abcd) is left unnamed.
function buyerOf(r) {
  const n = String(r.buyer_name ?? "").trim()
  return n && !/^0x[0-9a-f]/i.test(n) && !n.includes("…") ? n : null
}
// "Walt Disney Animation Studios • A Disney Villains Halloween Vol.2" -> "A Disney Villains Halloween Vol.2"
const shortSet = (s) => String(s ?? "").split(" • ").pop()
// "Lamine Yamal, Manga #20/25" · "LeBron James, Run It Back: Origins (Animated) #1/17". A serial the
// sale row does not carry is left off (never "/25" alone).
function topSaleSubject(r) {
  const who = r.player_name || shortSet(r.set_name) || "Unnamed"
  const set = shortSet(r.set_name)
  const sub = r.subedition_name ? ` (${r.subedition_name})` : ""
  const serial = r.serial_number ? ` #${r.serial_number}${r.circulation_count ? `/${int(r.circulation_count)}` : ""}` : ""
  return `${who}${set && set !== who ? `, ${set}` : ""}${sub}${serial}`
}

// Buyers are TAGGED only through this list: marketplace username (lowercase) -> X handle, each
// one confirmed by Trevor (or by the collector) as that person's account. A marketplace username is
// not an X handle — "@arbrevert" could be a stranger — so an unlisted buyer is named, not tagged.
// Keep in step with the same map in x-image.mjs.
export const X_HANDLES = {
  // Trevor, 11-09 (from the first top-10 post he finalized):
  themecca: "THEMECCA212",
  hichi: "chrisschlei",
  lions_for_breakfast: "FollowJay",
  // Trevor, 11-16 (from the 11-16 top-10 draft):
  jason3555: "jason3555",
  karso: "orangekarso",
}
function buyerLabel(name) {
  const h = X_HANDLES[String(name).toLowerCase()]
  return h ? `@${h.replace(/^@/, "")}` : name
}

async function mon() {
  // The week's top 10 sales, trailing 7 days, each with its buyer (Trevor, 11-09: "We should have it
  // be top sales from a week" → "include the full top 10 in the text, with an accompanying graphic
  // ... that has the images of the assets, the sale price, and the buyer"). One long post with the
  // image and no link; the link rides the reply, as on Sunday.
  const rows = await topSales7d()
  const link = `${SITE}/insights/top-sales`
  if (rows.length < 3) return { skip_reason: `only ${rows.length} sales on the 7-day top-sales board`, link }
  const top = rows.slice(0, 10)
  // The API resolves buyer usernames best-effort; a slow lookup returns the address instead (11-09:
  // the same LeBron sale came back as THEMECCA and as 0xfb33…e3f3 a minute apart). Re-ask a short
  // list for any buyer still unnamed and keep the first username seen.
  for (let tries = 0; tries < 2 && top.some((r) => !buyerOf(r)); tries++) {
    const again = await getJson("top-sales?window=7d&sort=price&limit=25")
    const byId = new Map((again.rows ?? []).map((r) => [r.sale_id, r]))
    for (const r of top) if (!buyerOf(r) && byId.get(r.sale_id) && buyerOf(byId.get(r.sale_id))) r.buyer_name = byId.get(r.sale_id).buyer_name
  }
  // Still an address: ask Dapper directly (Flow addresses only; Panini/Candy buyers are names already).
  for (const r of top) {
    if (buyerOf(r)) continue
    const u = await dapperUsername(r.buyer_address)
    if (u) r.buyer_name = u
  }
  const lines = top.map((r, i) => {
    const b = buyerOf(r)
    return `${i + 1}. ${topSaleSubject(r)} — ${usd(r.price_usd)} on ${BRAND[r.collection]?.handle.split(" ")[0] ?? coll(r.collection)}${b ? ` · bought by ${buyerLabel(b)}` : ""}`
  })
  // The API returns the week's top 200 by price. If even the 200th cleared the threshold, the
  // count is a floor, not a total — say nothing rather than under-count.
  const raw = await getJson("top-sales?window=7d&sort=price&limit=200")
  const truncatedAbove = (raw.rows ?? []).length >= 200 && Math.min(...raw.rows.map((r) => r.price_usd)) >= BIG_SALE_USD
  const over = truncatedAbove ? 0 : rows.filter((r) => r.price_usd >= BIG_SALE_USD).length
  const now = new Date()
  // Trevor's format, 11-09: "This past week's top 10 sales, 11/2-11/9 📈"; each line names the collection by its
  // official X account (Panini as plain @PaniniAmerica here); the count line leads with 💰.
  const head = `This past week's top ${top.length} sales, ${mdPT(new Date(now.getTime() - 7 * 86400000))}-${mdPT(now)} 📈`
  const tail = over > top.length ? [``, `💰${over} sales cleared ${usd(BIG_SALE_USD)} in the last 7 days.`] : []
  const unnamed = top.map((r, i) => (buyerOf(r) ? null : i + 1)).filter(Boolean)
  return {
    title: "The week's top sales",
    link,
    long_form: true,
    facts: { window: "trailing 7 days", sales_on_board: rows.length, over_1k: over, top },
    draft: [head, "", ...lines, ...tail].join("\n"),
    reply: [{ n: 2, of: 2, text: `Every sale on the board 👇\n${link}` }],
    thread_fallback: thread(lines, `${head}\n`, "").map((text, i, all) => ({ n: i + 1, of: all.length, text, len: xLength(text) })),
    buyers_untagged: [...new Set(top.map(buyerOf).filter((b) => b && !X_HANDLES[b.toLowerCase()]))],
    warnings_extra: unnamed.length
      ? [`no username for the buyer of #${unnamed.join(", #")} (wallet only) — the line names no buyer; never post the address`]
      : [],
  }
}

async function tue() {
  const d = await getJson("pack-sniper?limit=50")
  const link = `${SITE}/insights/pack-sniper`
  const deals = (d.deals ?? [])
    // Conservative: the expected value must still clear the ask after Top Shot's 5% selling fee,
    // the EV must cover the whole pool, and high-variance (chase/depleted) packs are left out.
    .filter((x) => !x.highVariance && x.fmvCoveragePct >= 90 && x.grossEV * 0.95 > x.lowestAsk)
    .sort((a, b) => b.grossEV / b.lowestAsk - a.grossEV / a.lowestAsk)
  const s = d.meta?.stats ?? {}
  const facts = { live_listings: s.liveListings, priced_packs: s.matched, qualifying: deals.length, deals: deals.slice(0, 3) }
  if (!deals.length) {
    return {
      title: "Top Shot pack check",
      link,
      facts,
      draft: `Pack check: we priced ${int(s.matched ?? 0)} Top Shot packs on the marketplace against what's left inside them.\n\nNone are listed below their expected value after fees this morning.\n\n${link}`,
    }
  }
  const lines = deals.slice(0, 3).map((x) => `• ${x.title}: ask ${usd(x.lowestAsk)}, expected contents ~${usd(x.grossEV)}`)
  return {
    title: "Top Shot pack check",
    link,
    facts,
    draft: fit(lines, `Top Shot packs listed below the expected value of what's still inside them:\n`, `\nPriced against unopened supply, not the original drop.\n${link}`),
  }
}

// Wednesday: the 2026 NBA rookie class, top 10 by Top Shot sales SINCE RELEASE across every
// edition (Trevor, 11-14 — the post he ran that Saturday, https://x.com/rippackscity/status/2121696498002084324,
// made weekly). One long post naming all ten, each line ending with the team's official hashtag,
// the image (x-image.mjs --slot wed: standard Rookie Debut moment, draft pick, season per-game
// line) attached, and the link in a 2/2 reply. Source: /api/public/insights/rookie-sales.
// Team hashtags: only ones Trevor confirmed live (they show the team's logo emoji on X); a team
// missing here gets no hashtag and a warning — never a guessed one.
const TEAM_HASHTAG = {
  "Washington Wizards": "#ForTheDistrict",
  "Sacramento Kings": "#LightTheBeam",
  "Memphis Grizzlies": "#GrindCity",
  "Utah Jazz": "#TakeNote",
  "Golden State Warriors": "#DubNation",
  "Chicago Bulls": "#SeeRed",
  "Oklahoma City Thunder": "#ThunderUp",
  "Cleveland Cavaliers": "#LetEmKnow",
  "LA Clippers": "#ClipperNation",
  "Los Angeles Clippers": "#ClipperNation",
  "Milwaukee Bucks": "#FearTheDeer",
  "Los Angeles Lakers": "#LakeShow",
}
// Dates a slot is skipped on purpose, with why. The task reports skip_reason and offers --slot sat.
const SKIP_DATES = {
  // Trevor, 11-14: "might be worth skipping the one in a few days since we did today".
  "2026-11-18": { wed: "the rookie top-10 ran early, Sat 11/14 (https://x.com/rippackscity/status/2121696498002084324)" },
}

async function wed(ctx) {
  const link = `${SITE}/insights/rookies?class=2026`
  const skip = SKIP_DATES[ctx.date]?.wed
  if (skip && !args.includes("--force")) return { title: "Rookie class top 10", link, skip_reason: `skipped this week: ${skip} (run with --force to draft it anyway)` }
  const d = await getJson("rookie-sales?class=2026&limit=10")
  const rows = (d.rows ?? []).filter((r) => r.sales > 0)
  if (!rows.length) return { skip_reason: "rookie sales board empty", link }
  const warnings = []
  const lines = rows.map((r) => {
    const tag = TEAM_HASHTAG[r.team_name]
    if (!tag) warnings.push(`no confirmed hashtag for ${r.team_name ?? "unknown team"} (${r.player_name}) — line has none; ask Trevor`)
    return `${r.rank}. ${r.player_name} — ${usd(r.gmv_usd)} · ${int(r.sales)} sales${tag ? ` ${tag}` : ""}`
  })
  for (const r of rows) {
    if (!r.season) warnings.push(`no season line for ${r.player_name} (ESPN name not matched once) — the image card shows none`)
    if (!r.image_nft_id) warnings.push(`no standard Rookie Debut moment sold for ${r.player_name} — the image tile is name-only`)
  }
  const t = d.totals ?? {}
  const head = `The 2026 rookie class on @NBATopShot: top ${rows.length} by sales since release 📈`
  const tail = `All ${int(t.players)} rookies: ${usd(t.gmv_usd)} across ${int(t.sales)} sales.`
  return {
    title: "Rookie class top 10",
    link,
    long_form: true,
    facts: { totals: t, top: rows, latest_sale_at: d.meta?.latest_sale_at, stats_through: d.meta?.stats_through },
    draft: [head, "", ...lines, "", tail].join("\n"),
    reply: [{ n: 2, of: 2, text: `See the full 2026 rookie class here 👇\n${link}` }],
    warnings_extra: warnings,
  }
}

// Some Panini names repeat the player across a dual card ("Travis Hunter | Travis Hunter — Downtown Duos").
function dealName(r) {
  const [who, set] = String(r.name || r.player_name || "").split(" — ")
  const people = [...new Set(who.split(" | ").map((x) => x.trim()).filter(Boolean))].join(" & ")
  return set ? `${people} ${set}` : people
}

async function thu() {
  const d = await getJson("deals?limit=50&sort=discount")
  const link = `${SITE}/insights/deals`
  const rows = (d.rows ?? [])
    // confidence is an INTERNAL filter only — it never appears in the post.
    .filter((r) => r.confidence === "HIGH" && !r.low_confidence_fmv && !EXCLUDED.has(r.collection_slug))
    .filter((r) => r.discount_usd >= 10 && r.discount_pct >= 15)
    .sort((a, b) => b.discount_usd - a.discount_usd)
  if (!rows.length) {
    const alt = await tradeIn()
    return { ...alt, title: "Deal of the week (fallback: trade-in)", skip_reason: "no listing $10+ and 15%+ under a well-supported value; used the trade-in board" }
  }
  const lines = rows.slice(0, 3).map((r) => `• ${dealName(r)} (${coll(r.collection_slug)}) — ask ${usd(r.low_ask)} vs value ${usd(r.fmv_usd)}`)
  return {
    title: "Deal of the week",
    link,
    facts: { data_as_of: d.meta?.data_as_of, qualifying: rows.length, top: rows.slice(0, 3) },
    draft: fit(lines, `Listed under value right now:\n`, `\nAsks move fast — live board:\n${link}`),
  }
}

async function fri(ctx) {
  const slug = FRIDAY_BOARDS[isoWeek(ctx.date) % FRIDAY_BOARDS.length]
  const link = `${SITE}/insights/${slug}`
  const meta = await pageDescription(slug)
  let sample = []
  let stats = null
  try {
    const d = await getJson(`${slug}?limit=5`)
    // Boards name their list differently (rows, deals, trophies…): take the first array that isn't meta.
    const list = Object.entries(d).find(([k, v]) => k !== "meta" && Array.isArray(v))?.[1] ?? []
    if (d.stats || d.cohort_stats) stats = d.stats ?? d.cohort_stats
    // Strip confidence fields so they cannot leak into a hand-written post.
    sample = list.slice(0, 5).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !/confidence/i.test(k))))
  } catch (e) {
    return { skip_reason: `board ${slug} API failed: ${e.message}`, link }
  }
  if (!sample.length) return { skip_reason: `board ${slug} returned no rows`, link }
  return {
    title: `Board drop: ${meta.title ?? slug}`,
    link,
    facts: { board: slug, page_title: meta.title, page_description: meta.description, stats, top_rows: sample },
    // A placeholder ONLY: write the hook from facts.stats / facts.top_rows (live numbers).
    // Never copy a figure out of page_description — static metadata is not live (first-mint
    // carried a stale "Average: 15.8×" until 2026-11-08).
    draft: `${meta.title ?? slug}\n\n${link}`,
    needs_rewrite: true,
  }
}

async function tradeIn() {
  const d = await getJson("trade-in?sort=cost&limit=10")
  const link = `${SITE}/insights/trade-in`
  const rows = (d.rows ?? []).filter((r) => r.cost_per_pack > 0 && r.moments_per_pack > 0)
  if (!rows.length) return { skip_reason: "trade-in board empty", link }
  const lines = rows.slice(0, 3).map(
    (r) => `• ${r.player_name} (${r.set_name}): ${r.moments_per_pack} Moment${r.moments_per_pack > 1 ? "s" : ""} for ${usd(r.cost_per_pack)} = 1 pack`,
  )
  return {
    title: "Top Shot This trade-in finder",
    link,
    facts: { asp_per_pack_usd: d.meta?.asp_per_pack_usd, top: rows.slice(0, 3) },
    draft: fit(
      lines,
      `Top Shot This trade-in: every ${usd(d.meta?.asp_per_pack_usd ?? 10)} of a player's Moments, at Top Shot's average sale price, counts as one pack.\n\nCheapest ways in right now:`,
      `\n${link}`,
    ),
  }
}

async function weekNumbers() {
  const d = await getJson("market-pulse")
  const link = `${SITE}/insights/market-pulse`
  const rows = (d.rows ?? [])
    .filter((r) => !EXCLUDED.has(r.slug) && r.sales_7d > 0 && r.volume_7d > 0)
    .sort((a, b) => b.volume_7d - a.volume_7d)
  if (!rows.length) return { skip_reason: "no collection had sales in 7d", link }
  const total = rows.reduce((s, r) => s + Number(r.volume_7d), 0)
  const lines = rows.map((r) => `${coll(r.slug)}: ${usd(r.volume_7d)} · ${int(r.sales_7d)} sales`)
  return {
    title: "Week in numbers",
    link,
    facts: { total_volume_7d: total, rows },
    draft: fit(lines, `The week in numbers (last 7 days): ${usd(total)} in sales.\n`, `\n${link}`),
  }
}

// ---------- drops (Sunday: the week ahead; any day: a drop opening or an RSVP closing soon) ----------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
// A weekday alone names THIS week's day; past ~6 days out add the date, past 14 days only the date
// (lib/insights/drops-board.ts whenPT, 2026-11-15).
function whenPT(iso) {
  const d = new Date(iso)
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  const mins = p.minute === "00" ? "" : `:${p.minute}`
  const day = DAY_NAMES.includes(p.weekday) ? p.weekday : p.weekday.slice(0, 3)
  const ahead = d.getTime() - Date.now()
  if (ahead > 14 * 86400000) return `${day} ${p.month}/${p.day}`
  if (ahead > 6 * 86400000) return `${day} ${p.month}/${p.day} ${p.hour}${mins} ${p.dayPeriod} PT`
  return `${day} ${p.hour}${mins} ${p.dayPeriod} PT`
}
const PACKS_PAGE = { nba_top_shot: "nba-top-shot", nfl_all_day: "nfl-all-day", laliga_golazos: "laliga-golazos", disney_pinnacle: "disney-pinnacle", panini_blockchain: "panini-blockchain" }
const packsIndex = (x) => `${SITE}/${PACKS_PAGE[x.collection] ?? "nba-top-shot"}/packs`
// Dapper's "RSVP" dists are what each app calls pre-orders (Top Shot, All Day) or a timed draw
// (Pinnacle: "requests close"). Use the app's word, never "RSVP".
const orderWord = (x) => (x.collection === "disney_pinnacle" ? "draw requests" : "pre-orders")
function dropLine(x, multiColl) {
  // Pinnacle: the set's minted supply rides the price ("$49.95, 490 minted"), from the chain via
  // pack-calendar's `minted` — minted, not capsules on offer (lib/insights/pack-calendar.ts).
  const parts = [x.retail_usd ? usd(x.retail_usd) : null, Number.isFinite(x.minted) && x.minted > 0 ? `${x.minted.toLocaleString("en-US")} minted` : null].filter(Boolean)
  const price = parts.length ? ` (${parts.join(", ")})` : ""
  const tag = multiColl ? `${coll(x.collection)}: ` : ""
  // A Pinnacle Open Edition is seen only while it mints: no price, no announced end.
  if (x.kind === "open_edition") return `• ${tag}${x.title} — minting now`
  // A Pinnacle mystery-capsule sale: when it opens or that it is on sale, plus what is inside.
  if (x.kind === "capsule") return `• ${tag}${x.title}${price} mystery capsules — ${x.status === "upcoming" ? `on sale ${whenPT(x.start_time)}` : "on sale now"}${x.detail ? `, ${x.detail}` : ""}`
  // A trade-in pack (Top Shot This): what you give, and when trade-ins close.
  if (x.kind === "trade_in") return `• ${tag}${x.title} — ${x.detail ? `${x.detail}, ` : ""}${x.status === "upcoming" ? `opens ${whenPT(x.start_time)}` : `closes ${whenPT(x.end_time)}`}`
  // An upcoming Pinnacle "RSVP" may be a draw or a capsule sale (the book marks both): "opens" is
  // true of both (same rule as lib/insights/drops-board.ts dropStatusLine).
  if (x.status === "upcoming" && x.kind === "rsvp" && x.collection === "disney_pinnacle") return `• ${tag}${x.title}${price} — opens ${whenPT(x.start_time)}`
  if (x.status === "upcoming") return `• ${tag}${x.title}${price} — ${x.kind === "rsvp" ? `${orderWord(x)} open` : "drops"} ${whenPT(x.start_time)}`
  // open now: a pre-order / draw window closes; a sale has an end time only sometimes
  if (x.kind === "rsvp" && x.end_time) return `• ${tag}${x.title}${price} — ${orderWord(x)} close ${whenPT(x.end_time)}`
  return `• ${tag}${x.title}${price} — on sale now${x.end_time ? ` until ${whenPT(x.end_time)}` : ""}${x.low_stock ? ", almost sold out" : ""}`
}
async function pageLive(href) {
  try {
    const r = await fetch(`${SITE}${href}`, { headers: { "user-agent": "rpc-x-calendar/1.0" } })
    return r.status === 200
  } catch {
    return false
  }
}
// Drops come from every source the calendar reads: the Atlas pack book (Top Shot, All Day, Golazos,
// Pinnacle), Pinnacle Open Editions minting now (pinnacle_mint_events), Panini's own store
// (panini_pack_drops) and Candy MLB's blog announcements. A source with
// no as-of is UNREAD: its drops are missing, so the post must not read as the whole week.
const ATLAS_NAMES = { nba: "Top Shot", nfl: "All Day", laliga: "Golazos", disney: "Pinnacle", panini: "Panini", candy: "Candy MLB", pinnacle_oe: "Pinnacle Open Editions" }
let calendarMeta = null
let calendarAnnouncements = []
async function calendar() {
  const d = await getJson("pack-calendar")
  calendarMeta = d.meta ?? {}
  const unread = Object.entries(calendarMeta.complete_at ?? {}).filter(([, at]) => !at).map(([p]) => ATLAS_NAMES[p] ?? p)
  if (unread.includes("Top Shot") || unread.includes("All Day")) throw new Error(`the Atlas pack book is unread for ${unread.join(", ")}`)
  calendarMeta.unread = unread
  calendarAnnouncements = Array.isArray(d.announcements) ? d.announcements : []
  return d.drops ?? []
}

// The Sunday post is "The RPC Weekly Pack Drop Report" (Trevor's format, 11-08): one long post
// (the account posts long-form), a dated header, then one line per drop — the collection's emoji,
// its OFFICIAL X handle (read from each app's own site footer 11-08), title, price, and when, in
// PT — and the drops page link last. The image rides on it (scripts/social/x-image.mjs).
const BRAND = {
  nba_top_shot: { emoji: "🏀", handle: "@NBATopShot" },
  nfl_all_day: { emoji: "🏈", handle: "@NFLAllDay" },
  laliga_golazos: { emoji: "⚽", handle: "@LaLigaGolazos" },
  disney_pinnacle: { emoji: "📌", handle: "@DisneyPinnacle" },
  panini_blockchain: { emoji: "🃏", handle: "@PaniniAmerica Blockchain" },
  candy_mlb: { emoji: "⚾", handle: "@CandyDigital" },
}
// Panini lists a sport per pack; its line takes that sport's emoji.
const PANINI_SPORT_EMOJI = { BASKETBALL: "🏀", "WOMENS BASKETBALL": "🏀", FOOTBALL: "🏈", SOCCER: "⚽", "WOMENS SOCCER": "⚽", BASEBALL: "⚾", HOCKEY: "🏒", RACING: "🏁", ENTERTAINMENT: "🎸" }
function reportLine(x) {
  const b = BRAND[x.collection] ?? { emoji: "📦", handle: x.collection }
  const emoji = x.collection === "panini_blockchain" ? PANINI_SPORT_EMOJI[(x.sport ?? "").toUpperCase()] ?? b.emoji : b.emoji
  return dropLine(x, false).replace(/^• /, `${emoji} ${b.handle}: `)
}
function mdPT(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" }).format(d)
}

// Packs named for one player: Top Shot This, Tip-Off, auction and reward packs.
function isPlayerPack(x) {
  return x.collection === "nba_top_shot" && /tip-off|top shot this|auction|reward/i.test(x.title)
}

async function drops() {
  const all = await calendar()
  const ahead = all.filter((x) => x.status !== "ended")
  if (!ahead.length && !calendarAnnouncements.length) return { skip_reason: "no drop is open or scheduled in the next 7 days on any collection the calendar reads", link: `${SITE}/insights/drops` }
  // The drops page lists the whole week and always exists; its preview card is the live week.
  const link = `${SITE}/insights/drops`
  // Priciest first: the drops collectors are deciding on lead.
  const byPrice = [...ahead].sort((a, b) => (b.retail_usd ?? 0) - (a.retail_usd ?? 0) || a.start_time.localeCompare(b.start_time))
  // NEW FIRST (Trevor, 11-15: "Feels like we covered a lot of these last week"). A drop that had already
  // started when this report runs was on an earlier report (or its follow-up), so it moves under
  // "Still on sale" — still named in full (never "+N more"), just not leading the post.
  const now = new Date()
  const isNew = (x) => x.status === "upcoming" || Date.parse(x.start_time) > now.getTime() - 36 * 3600000
  const fresh = byPrice.filter(isNew)
  const carried = byPrice.filter((x) => !isNew(x))
  if (!fresh.length && !calendarAnnouncements.length) return { skip_reason: `no NEW drop this week (still on sale from earlier reports: ${carried.map((x) => x.title).join(", ") || "none"})`, link: `${SITE}/insights/drops` }
  const lines = fresh.map(reportLine)
  // Candy MLB has no store listing (its store is offline); a drop it ANNOUNCED this week rides as a line.
  for (const a of calendarAnnouncements) lines.push(`${BRAND.candy_mlb.emoji} ${BRAND.candy_mlb.handle}: ${a.title}`)
  // Trevor, 11-15: "We need to pull the pinnacle drop since we already covered it last week and it's not
  // a new drop" — a drop already on sale was on an earlier report, so the post leaves it out entirely.
  // facts.carried_over names them for the drafter; the drops page still lists them.
  const head = `The RPC Weekly Pack Drop Report, ${mdPT(now)}-${mdPT(new Date(now.getTime() + 7 * 86400000))} 📦`
  const covered = Object.keys(calendarMeta?.complete_at ?? {}).map((p) => ATLAS_NAMES[p] ?? p).filter((n) => !calendarMeta.unread.includes(n))
  return {
    title: "The RPC Weekly Pack Drop Report",
    link,
    long_form: true,
    facts: {
      drops: fresh,
      carried_over: carried.map((x) => x.title),
      ended_this_week: all.filter((x) => x.status === "ended").length,
      collections_covered: covered,
      collections_unread: calendarMeta?.unread ?? [],
      announcements: calendarAnnouncements,
      // UFC Strike's market is closed (docs/social/x-calendar.md): never say it had no drops.
      collections_not_covered: ["UFC Strike (closed)"],
    },
    // One long post naming every drop, with NO link in it (Trevor, 11-08: a link holds the main
    // post back in X's ranking); the link rides in reply[], posted as a reply so its preview card
    // shows there. thread_fallback is for when long posts are unavailable.
    draft: [head, "", ...lines].join("\n"),
    // ?w=<MMDD> (PT) makes each week's link a URL X has not cached: X keeps a link's card ~7 days by
    // PAGE URL, so the bare link unfurled last week's card on 11-15 even after og:image went per-day.
    reply: [{ n: 2, of: 2, text: `Learn more about this week's drops here 👇\n${link}?w=${mdPT(now).split("/").map((x) => x.padStart(2, "0")).join("")}` }],
    thread_fallback: thread(lines, `${head}\n`, "").map((text, i, all) => ({ n: i + 1, of: all.length, text, len: xLength(text) })),
    // A pack named for one player ends with that player's team hashtag (docs/social/x-calendar.md).
    // The calendar does not carry the team, so the drafter flags the lines to finish by hand.
    warnings_extra: [
      // Top Shot This trade-in packs are REWARD dists in the book, so never listed: each needs a hand entry (11-16 Curry went out on no report).
      ...(calendarMeta?.needs_hand_entry ?? []).map((x) => `"${x.title}" (Top Shot dist ${x.dist_id}, from ${whenPT(x.start_time)}) is a Top Shot This trade-in pack with no hand entry — read https://nbatopshot.com/?packDetail=${x.dist_id} and add it to MANUAL_DROPS (lib/insights/manual-drops.ts), or add it to the post by hand`),
      ...(calendarMeta?.unread?.length ? [`pack book unread for ${calendarMeta.unread.join(", ")} — their drops are missing from this list`] : []),
      ...(await officialSourcesNotOnCalendar(all, now)),
      ...byPrice.filter(isPlayerPack).map((x) => `"${x.title}" is a player pack — end its line with the team's hashtag (docs/social/x-calendar.md)`),
    ],
  }
}

// MISSED-DROP PROBE (2026-11-15). The 11-15 draft missed Top Shot's 2026 WNBA Finals drop (on its blog
// since 11-12, not yet in the pack book) and Pinnacle's Friends-Giving Vol.2 waiting-room sale (draw
// closed, 622 capsules still on sale to 11-20). Both official sources are read here and anything the
// calendar does not carry becomes a warning for the drafter to verify and add — never a line by itself.
const norm = (t) => String(t ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&amp;|\\u0026/g, "&").toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim()
async function officialSourcesNotOnCalendar(all, now) {
  const out = []
  const titles = all.filter((x) => x.status !== "ended").map((x) => norm(x.title))
  const onCalendar = (name) => titles.some((t) => t.includes(norm(name)))
  // Top Shot blog (Webflow, no feed): "Drop Guide" posts dated in the last 10 days.
  try {
    const html = await (await fetch("https://blog.nbatopshot.com/", { signal: AbortSignal.timeout(15000) })).text()
    const text = html.replace(/<[^>]*>/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean)
    for (let i = 0; i < text.length; i++) {
      // Drop guides, and trade-in auctions (11-22: no feed carries them — "Trade In Old for New", 11-06).
      if (!/drop guide|trade[- ]in|auction/i.test(text[i])) continue
      const dateLine = text.slice(i + 1, i + 8).find((l) => /^[A-Z][a-z]{2,8} \d{1,2}(, \d{4})?$/.test(l))
      if (!dateLine) continue
      const posted = new Date(/\d{4}$/.test(dateLine) ? dateLine : `${dateLine}, ${now.getFullYear()}`)
      if (!(now - posted < 10 * 86400000)) continue
      if (!/drop guide/i.test(text[i])) {
        out.push(`Top Shot blog posted "${text[i]}" (${dateLine}) — a trade-in auction is in no feed: read it and, if one opens this week, add it by hand (lib/insights/manual-drops.ts)`)
        continue
      }
      const subject = text[i].replace(/drop guide/i, "").replace(/\b20\d\d\b/, "").trim()
      if (!onCalendar(subject)) out.push(`Top Shot blog posted "${text[i]}" (${dateLine}) and the calendar has no "${subject}" drop — read it and add its packs (lib/insights/manual-drops.ts) before posting`)
    }
  } catch (e) {
    out.push(`could not read blog.nbatopshot.com (${e.message}) — check it by hand for this week's drop guides`)
  }
  // Pinnacle releases page: releases purchasable now, or opening within 7 days.
  try {
    const html = (await (await fetch("https://disneypinnacle.com/releases", { signal: AbortSignal.timeout(15000) })).text()).replace(/\\"/g, '"')
    const re = /"\$typeName":"atlas\.v1\.Release","releaseId":"([^"]+)","product":"disney","title":"([^"]+)"/g
    const starts = [...html.matchAll(re)]
    if (!starts.length) throw new Error("no releases parsed from the page")
    // The REVERSE check (11-22): a Pinnacle drop going in the post that the official page does not
    // list yet (Frozen Seasonal Harvest Vol.1 and Winnie the Pooh: Friends-Giving Vol.2 were in the
    // pack book and minted, not on the page) — its format (draw or capsules) and close are unconfirmed.
    const pageTitles = starts.map((m) => norm(m[2].replace(/\\u0026/g, "&")))
    const isNew = (x) => x.status === "upcoming" || Date.parse(x.start_time) > now.getTime() - 36 * 3600000
    for (const x of all) {
      if (x.collection !== "disney_pinnacle" || x.status === "ended" || x.kind === "open_edition" || !isNew(x)) continue
      const t = norm(x.title)
      if (!pageTitles.some((pt) => pt.includes(t) || t.includes(pt))) out.push(`"${x.title}" (Pinnacle, from the pack book) is not on disneypinnacle.com/releases yet — its format (timed draw or mystery capsules) and close are unconfirmed; the post says "opens", re-check the page before posting`)
    }
    starts.forEach((m, k) => {
      const seg = html.slice(m.index, starts[k + 1]?.index ?? m.index + 60000)
      const ts = (key) => Number(seg.match(new RegExp(`"${key}":\\{[^}]*"seconds":"\\$n(\\d+)"`))?.[1] ?? NaN) * 1000
      const purchasable = /"isPurchasable":true/.test(seg)
      const start = ts("purchaseStartDate")
      const soon = Number.isFinite(start) && start > now.getTime() && start - now.getTime() < 7 * 86400000
      const title = m[2].replace(/\\u0026/g, "&")
      if ((purchasable || soon) && !onCalendar(title)) out.push(`disneypinnacle.com/releases shows "${title}" ${purchasable ? "purchasable now" : `opening ${new Date(start).toISOString()}`} and the calendar does not list it open — check https://disneypinnacle.com/releases/${m[1]} and add a DROP_CORRECTIONS / MANUAL_DROPS entry`)
    })
  } catch (e) {
    out.push(`could not read disneypinnacle.com/releases (${e.message}) — check it by hand`)
  }
  return out
}

// A drop starting, or an RSVP closing, within the next 24 h gets its own optional reminder.
async function dropAlerts(now) {
  try {
    const all = await calendar()
    const soon = (iso) => iso && new Date(iso) - now > 0 && new Date(iso) - now < 86400000
    const due = all
      .filter((x) => (x.status === "upcoming" && soon(x.start_time)) || (x.kind === "rsvp" && x.status === "open" && soon(x.end_time)))
      .slice(0, 2)
    const out = []
    for (const x of due) out.push({ x, live: await pageLive(x.detail_href) })
    return out
      .map(({ x, live }) => {
        const what = x.status === "upcoming" ? `${x.kind === "rsvp" ? `${orderWord(x)} open` : "drops"} ${whenPT(x.start_time)}` : `${orderWord(x)} close ${whenPT(x.end_time)}`
        const draft = `Reminder: ${x.title}${x.retail_usd ? ` (${usd(x.retail_usd)})` : ""} — ${what}.\n\n${live ? `${SITE}${x.detail_href}` : packsIndex(x)}`
        return { drop: x, draft, draft_len: xLength(draft), intent_url: intent(draft) }
      })
  } catch (e) {
    return [{ error: e.message }]
  }
}

// Any sale in the last 24 h that cleared $1,000 AND ranks in the week's top 5 is worth its own post.
// Format as first posted (Trevor, 11-14: https://x.com/rippackscity/status/2121645350356476091): the
// post names the sale, its price on the collection's official account and the buyer (Trevor, 11-14:
// "You should put the buyer on there too" — same naming rule as Monday: a confirmed X_HANDLES tag,
// else the marketplace username untagged, never a wallet); the link rides a 2/2 reply; the image is
// x-image.mjs --slot big (image_cmd). The opening line is generic — when the sale is a "first" (11-14:
// "This season's first Rookie Ultimate sale is in 🏀") the task rewrites it, and passes the same
// words to --headline.
async function breaking(now) {
  try {
    const rows = await topSales7d()
    const big = rows
      .slice(0, 5)
      .filter((r) => r.price_usd >= BIG_SALE_USD && now - new Date(r.sold_at) < 86400000)
      .slice(0, 2)
    for (const r of big) {
      if (buyerOf(r)) continue
      const u = await dapperUsername(r.buyer_address)
      if (u) r.buyer_name = u
    }
    return big.map((r) => {
      const b = buyerOf(r)
      const on = BRAND[r.collection]?.handle.split(" ")[0] ?? coll(r.collection)
      const draft = `One of the week's top sales ${BRAND[r.collection]?.emoji ?? "💰"}\n\n${topSaleSubject(r)} — ${usd(r.price_usd)} on ${on}${b ? ` · bought by ${buyerLabel(b)}` : ""}`
      return {
        sale: r,
        draft,
        draft_len: xLength(draft),
        intent_url: intent(draft),
        reply: [{ n: 2, of: 2, text: `See the week's top sales here 👇\n${SITE}/insights/top-sales` }],
        image_cmd: `node x-image.mjs --slot big --sale ${r.sale_id} --video --out "$HOME/xdraft/img"`,
      }
    })
  } catch (e) {
    return [{ error: e.message }]
  }
}

// ---------- main ----------
const now = new Date()
const today = arg("date") ?? ptParts(now).date
const dow = new Date(`${today}T12:00:00Z`).getUTCDay()
const slot = arg("slot") ?? SLOTS[dow]
const ctx = { date: today, dow: SLOTS.indexOf(slot) }
const run = { sun: drops, mon, tue, wed, thu, fri, sat: weekNumbers }[slot]
if (!run) {
  console.error(`unknown slot ${slot}; use one of ${SLOTS.join(" ")}`)
  process.exit(2)
}

const out = { date_pt: today, slot, generated_at: now.toISOString(), warnings: [] }
try {
  Object.assign(out, await run(ctx))
} catch (e) {
  out.skip_reason = `slot failed: ${e.message}`
}
if (out.warnings_extra) {
  out.warnings.push(...out.warnings_extra)
  delete out.warnings_extra
}
if (out.draft) {
  if (/\bDUC\b/.test(out.draft)) out.warnings.push("draft contains 'DUC' — rewrite as dollars")
  if (/confidence|HIGH|MEDIUM|LOW\b/.test(out.draft)) out.warnings.push("draft mentions confidence — remove it")
  if (/ufc/i.test(out.draft)) out.warnings.push("draft mentions UFC — its market is closed")
  out.draft_len = xLength(out.draft)
  // Long-form posts (the drops report) go up to X's long-post limit; everything else is a standard post.
  const limit = out.long_form ? 25000 : 280
  if (out.draft_len > limit) out.warnings.push(`draft is ${out.draft_len} characters; the limit is ${limit}`)
  out.intent_url = intent(out.draft)
}
for (const p of out.thread ?? []) {
  if (p.len > 280) out.warnings.push(`thread post ${p.n}/${p.of} is ${p.len} characters; X allows 280`)
  if (/\bDUC\b|confidence|ufc/i.test(p.text)) out.warnings.push(`thread post ${p.n}/${p.of} breaks a house rule (DUC / confidence / UFC)`)
}
out.breaking = await breaking(now)
// Sunday's post already lists every drop, so the reminders ride the other six days.
out.drop_alerts = slot === "sun" ? [] : await dropAlerts(now)
// The missed-drop probe runs daily too: a drop guide posted midweek (WNBA Finals, Thu 11-12) should not
// wait for Sunday to be noticed.
if (slot !== "sun") {
  try {
    for (const w of await officialSourcesNotOnCalendar(await calendar(), now)) out.warnings.push(`drops: ${w}`)
  } catch (e) {
    out.warnings.push(`drops: missed-drop probe failed (${e.message})`)
  }
}
console.log(JSON.stringify(out, null, 2))
