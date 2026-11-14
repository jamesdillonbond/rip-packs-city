#!/usr/bin/env node
// scripts/social/x-image.mjs — the image(s) that ride with a day's @RipPacksCity post.
//
// X ranks a post with an attached image above a bare link card, so each post ships an RPC-branded
// image drawn from the same public API the text came from (docs/social/x-calendar.md § Images).
// Renders HTML with Playwright's Chromium (pre-installed in the cloud sandbox and the scheduled
// task) — no server route, no secrets.
//
//   node scripts/social/x-image.mjs --slot sun --out /tmp/xdraft      # drops this week
//   ... --exclude 8912,8913   # leave out drops the pre-post check found already over (listed in output)
//   ... --add extra.json      # add drops the pre-post check confirmed on an official page that no feed
//                             # lists (e.g. a trade-in-only pack): [{collection,title,price,status,after}]
//
// Prints JSON: { slot, images: [paths], items, warnings }. Every item in the post is on an image —
// a list longer than one image fits is split across images (X allows 4 per post), never cut.
//
//   node scripts/social/x-image.mjs --slot mon --out /tmp/xdraft      # the week's top 10 sales
//   node scripts/social/x-image.mjs --slot big --out /tmp/xdraft --video   # one big sale (still + MP4)
//   ... --sale <sale_id> --headline "line one|line two"   (see § big below)
//
// House rules (same as the text): dollars only, never "DUC"; no FMV confidence; Pinnacle assets
// are characters; no UFC. Drops (sun): brand art only — no pack art or partner artwork.
// Top sales (mon): each sale shows its asset's own image, price and buyer username (Trevor, 11-09);
// a buyer known only by wallet address is left blank, never printed as the address.

import { mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SITE = "https://www.rippackscity.com"
const API = `${SITE}/api/public/insights`
const RAW = "https://raw.githubusercontent.com/jamesdillonbond/rip-packs-city/main"
const TZ = "America/Los_Angeles"
const PER_IMAGE = 9
const W = 1200
const H = 675

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..")

// Fonts and logo: from this checkout when present, else from the public repo (the scheduled task
// fetches only this file).
async function asset(rel) {
  const local = join(REPO, rel)
  if (existsSync(local)) return readFileSync(local)
  const r = await fetch(`${RAW}/${rel}`)
  if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

const COLL = {
  nba_top_shot: { label: "NBA Top Shot", accent: "#E03A2F" },
  nfl_all_day: { label: "NFL All Day", accent: "#4F94D4" },
  disney_pinnacle: { label: "Disney Pinnacle", accent: "#A855F7" },
  laliga_golazos: { label: "LaLiga Golazos", accent: "#22C55E" },
  panini_blockchain: { label: "Panini", accent: "#C084FC" },
  candy_mlb: { label: "Candy MLB", accent: "#FB923C" },
}

const usd = (n) =>
  "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0, minimumFractionDigits: n < 100 && n % 1 ? 2 : 0 })
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
function whenPT(iso) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" })
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  const mins = p.minute === "00" ? "" : `:${p.minute}`
  return `${DAY_NAMES.includes(p.weekday) ? p.weekday : p.weekday.slice(0, 3)} ${p.hour}${mins} ${p.dayPeriod} PT`
}
function dayPT(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d)
}

// The same wording as x-draft.mjs's dropLine, split into a status line.
function statusLine(x) {
  if (x.kind === "open_edition") return "Minting now"
  if (x.kind === "capsule") return x.status === "upcoming" ? `Capsules on sale ${whenPT(x.start_time)}` : "Capsules on sale now"
  if (x.kind === "trade_in") return x.status === "upcoming" ? `Trade-ins open ${whenPT(x.start_time)}` : x.end_time ? `Trade-ins close ${whenPT(x.end_time)}` : "Trade-ins open now"
  const word = x.collection === "disney_pinnacle" ? "Draw requests" : "Pre-orders"
  if (x.status === "upcoming") return `${x.kind === "rsvp" ? `${word} open` : "Drops"} ${whenPT(x.start_time)}`
  if (x.kind === "rsvp" && x.end_time) return `${word} close ${whenPT(x.end_time)}`
  const base = x.end_time ? `On sale until ${whenPT(x.end_time)}` : "On sale now"
  return x.low_stock ? `${base} · almost sold out` : base
}

async function dropsItems() {
  const r = await fetch(`${API}/pack-calendar`, { headers: { "user-agent": "rpc-x-calendar/1.0" } })
  if (!r.ok) throw new Error(`pack-calendar: HTTP ${r.status}`)
  const d = await r.json()
  const unread = Object.entries(d.meta?.complete_at ?? {}).filter(([, at]) => !at).map(([k]) => k)
  const excluded = new Set((arg("exclude") ?? "").split(",").map((s) => s.trim()).filter(Boolean))
  const ahead = (d.drops ?? []).filter((x) => x.status !== "ended" && !excluded.has(x.dist_id))
  // Same order as the thread: priciest first.
  ahead.sort((a, b) => (b.retail_usd ?? 0) - (a.retail_usd ?? 0) || a.start_time.localeCompare(b.start_time))
  const items = ahead.map((x) => ({
    collection: x.collection,
    title: x.title,
    price: x.retail_usd != null ? usd(x.retail_usd) : null,
    status: statusLine(x),
    upcoming: x.status === "upcoming",
    detail: x.detail ?? null,
  }))
  for (const a of d.announcements ?? []) items.push({ collection: "candy_mlb", title: a.title, price: null, status: "Announced", upcoming: false })
  // Verified extras go in at the position the post lists them (after the named title, else last).
  const extraPath = arg("add")
  if (extraPath) {
    for (const e of JSON.parse(readFileSync(extraPath, "utf8"))) {
      const at = e.after ? items.findIndex((i) => i.title === e.after) : -1
      const it = { collection: e.collection, title: e.title, price: e.price ?? null, status: e.status, upcoming: !!e.upcoming, detail: e.detail ?? null }
      if (at >= 0) items.splice(at + 1, 0, it)
      else items.push(it)
    }
  }
  return { items, unread }
}

function card(it, big) {
  const c = COLL[it.collection] ?? { label: it.collection, accent: "#E03A2F" }
  return `<div class="card${big ? " big" : ""}" style="--acc:${c.accent}">
    <div class="chip"><span class="dot"></span>${esc(c.label)}</div>
    <div class="title">${esc(it.title)}</div>
    ${big && it.detail ? `<div class="detail">${esc(it.detail).replace(/-/g, "\u2011")}</div>` : ""}
    <div class="row">${it.price ? `<span class="price">${esc(it.price)}</span>` : ""}<span class="when${it.upcoming ? " soon" : ""}">${esc(it.status)}</span></div>
  </div>`
}

function page({ items, pageNo, pages, fonts, logo, now }) {
  const n = items.length
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 6 || n === 9 ? 3 : 4
  const rows = Math.ceil(n / cols)
  // Three rows only fit the 675px canvas with tighter type; the page check below catches a miss.
  const dense = rows >= 3
  // One to three drops: centred cards sized to their content, with room for a detail line
  // (Trevor, 11-08: "center and make the graphic a little more visually appealing").
  const spacious = n <= 3
  const cardW = n === 1 ? 640 : n === 2 ? 500 : 340
  const range = `${dayPT(now)} – ${dayPT(new Date(now.getTime() + 7 * 86400000))}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Barlow;src:url(data:font/ttf;base64,${fonts.barlow}) format("truetype")}
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${fonts.mono}) format("truetype")}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;background:#080808;color:#F2F2F2;font-family:Barlow,sans-serif;overflow:hidden;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 100% 0%,rgba(224,58,47,.22),transparent 60%),radial-gradient(700px 400px at 0% 100%,rgba(224,58,47,.10),transparent 60%)}
.stripe{position:absolute;left:0;top:0;bottom:0;width:10px;background:#E03A2F}
.wrap{position:absolute;inset:0;padding:${dense ? '26px 44px 22px 54px' : '34px 44px 30px 54px'};display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between}
h1{font-size:${dense ? 56 : 70}px;line-height:.9;letter-spacing:.5px;text-transform:uppercase}
h1 em{font-style:normal;color:#E03A2F}
.sub{font-family:Mono,monospace;font-size:19px;color:#BFC0BF;margin-top:8px}
.logo{width:104px;height:104px}
.grid{flex:1;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},minmax(0,1fr));gap:${dense ? 10 : 14}px;margin:${dense ? '14px 0 10px' : '22px 0 16px'};min-height:0}
.card{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.12);border-top:4px solid var(--acc);border-radius:12px;padding:${dense ? '9px 14px' : '14px 16px'};display:flex;flex-direction:column;min-width:0;min-height:0}
.chip{font-family:Mono,monospace;font-size:14px;color:#BFC0BF;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:8px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--acc)}
.title{font-size:${cols >= 4 || dense ? 27 : 36}px;line-height:1.02;text-transform:uppercase;margin:${dense ? 4 : 8}px 0 auto;overflow-wrap:anywhere}
.row{display:flex;flex-direction:${dense ? 'row' : 'column'};${dense ? 'align-items:baseline;flex-wrap:wrap;column-gap:14px;' : ''}gap:4px;margin-top:${dense ? 6 : 10}px}
.price{font-family:Mono,monospace;font-size:${cols >= 4 || dense ? 27 : 36}px;color:#fff}
.when{font-family:Mono,monospace;font-size:${cols >= 4 || dense ? 16 : 18}px;color:#FF4D40}
.when.soon{color:#FBBF24}
.spacious .grid{flex:0 0 auto;display:flex;flex-wrap:nowrap;align-items:stretch;justify-content:center;gap:28px;margin:auto 0}
.spacious .card{width:${cardW}px;flex:0 0 auto;min-height:${n <= 2 ? 300 : 280}px;padding:26px 30px 28px;border-radius:18px;border-top-width:5px;
  background:linear-gradient(165deg,color-mix(in srgb,var(--acc) 20%,transparent),rgba(255,255,255,.03) 55%);
  box-shadow:0 0 0 1px rgba(255,255,255,.04),0 24px 70px -24px color-mix(in srgb,var(--acc) 70%,transparent)}
.spacious .chip{font-size:15px}
.spacious .title{font-size:${n <= 2 ? 42 : 34}px;line-height:1;margin:14px 0 0}
.spacious .detail{font-family:Mono,monospace;font-size:15px;line-height:1.35;color:#D4D4D4;margin-top:14px}
.spacious .row{margin-top:auto;padding-top:22px;gap:12px}
.spacious .price{font-size:${n <= 2 ? 58 : 46}px;line-height:1}
.spacious .when{align-self:flex-start;font-size:16px;padding:7px 12px;border-radius:999px;background:rgba(255,77,64,.12);border:1px solid rgba(255,77,64,.35)}
.spacious .when.soon{background:rgba(251,191,36,.10);border-color:rgba(251,191,36,.35)}
.spacious .glow{position:absolute;left:50%;top:58%;width:900px;height:420px;transform:translate(-50%,-50%);
  background:radial-gradient(closest-side,color-mix(in srgb,${COLL[items[0]?.collection]?.accent ?? "#E03A2F"} 22%,transparent),transparent);pointer-events:none}
footer{display:flex;justify-content:space-between;font-family:Mono,monospace;font-size:17px;color:#BFC0BF}
footer b{color:#fff;font-weight:400}
</style></head><body class="${spacious ? "spacious" : ""}"><div class="bg"></div>${spacious ? '<div class="glow"></div>' : ""}<div class="stripe"></div><div class="wrap">
<header><div><h1>Drops <em>this week</em></h1><div class="sub">${esc(range)} · every drop open now or starting soon · times PT · retail prices${pages > 1 ? ` · ${pageNo}/${pages}` : ""}</div></div>
<img class="logo" src="data:image/png;base64,${logo}"></header>
<div class="grid">${items.map((it) => card(it, spacious)).join("")}</div>
<footer><span><b>rippackscity.com</b></span><span>@RipPacksCity</span></footer>
</div></body></html>`
}

// ---------- mon: the week's top 10 sales ----------
const SITE_NAMES = { nba_top_shot: "Top Shot", nfl_all_day: "All Day", disney_pinnacle: "Pinnacle", laliga_golazos: "Golazos", panini_blockchain: "Panini", candy_mlb: "Candy MLB" }
// Same rules as x-draft.mjs's buyerOf / shortSet (kept in step by hand: this file is fetched alone).
function buyerOf(r) {
  const n = String(r.buyer_name ?? "").trim()
  return n && !/^0x[0-9a-f]/i.test(n) && !n.includes("…") ? n : null
}
const shortSet = (s) => String(s ?? "").split(" • ").pop()
// Confirmed X handles for buyers (marketplace username, lowercase -> handle). Same list as x-draft.mjs.
const X_HANDLES = { themecca: "THEMECCA212", hichi: "chrisschlei", lions_for_breakfast: "FollowJay" }

async function getJson(path) {
  const r = await fetch(`${API}/${path}`, { headers: { "user-agent": "rpc-x-calendar/1.0" } })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

// The asset's image as a data URI (Playwright then needs no network). A Pinnacle thumbnail is our
// own resolver route, which redirects to a freshly signed Dapper URL.
async function imageData(url) {
  if (!url) return null
  const abs = url.startsWith("/") ? `${SITE}${url}${url.includes("pinnacle-image") ? "?v=thumb" : ""}` : url
  try {
    const r = await fetch(abs, { redirect: "follow", signal: AbortSignal.timeout(25_000) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    // Panini's CDN serves its PNGs as application/octet-stream: trust the bytes, not the header.
    const sniff = buf.subarray(0, 4).toString("hex")
    const type = sniff === "89504e47" ? "image/png" : sniff.startsWith("ffd8ff") ? "image/jpeg"
      : buf.subarray(8, 12).toString() === "WEBP" ? "image/webp" : (r.headers.get("content-type") ?? "").split(";")[0]
    if (!type.startsWith("image/")) return null
    return `data:${type};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

// A Dapper wallet's username from Disney Pinnacle's public GQL (one Dapper username per wallet across
// every Dapper app): the owner of any pin the wallet holds carries it. Used only when the insights API
// returned an address (11-09: the week's two Pinnacle sales went to 0x6de0…cade, which no RPC table
// had named). null when the wallet holds no Pinnacle pin or the call fails. Same as x-draft.mjs.
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

// Our Pinnacle image route asks Dapper's search index for a signed URL, and that index is missing
// some Legendary pins (11-09: every LGEV2-DVHA render 404s). The pin's own public page,
// disneypinnacle.com/pin/<nft_id>, carries signed render URLs for it: take the cropped front.
async function pinnaclePinImage(r) {
  const render = String(r.external_id ?? "")
  if (!r.nft_id || !/^[A-Z0-9-]{3,64}$/.test(render)) return null
  try {
    const res = await fetch(`https://disneypinnacle.com/pin/${encodeURIComponent(r.nft_id)}`, { signal: AbortSignal.timeout(20_000) })
    const html = (await res.text()).replace(/\\u0026|&amp;/g, "&")
    for (const file of ["front_cropped", "front", "idle_cropped"]) {
      const re = new RegExp(`https://assets\\.disneypinnacle\\.com/render/${render}/${file}\\.png\\?exp=\\d+&sig=[0-9a-f]+`)
      const m = html.match(re)
      const img = m ? await imageData(m[0]) : null
      if (img) return img
    }
  } catch {}
  return null
}

// A String object can carry a flag and still work everywhere a data-URI string does.
const padded = (data) => {
  if (!data) return null
  const v = new String(data)
  v.padded = true
  return v
}

async function topSalesItems(warnings) {
  const d = await getJson("top-sales?window=7d&sort=price&limit=200")
  const rows = (d.rows ?? []).filter((r) => r.collection !== "ufc_strike" && r.price_usd > 0).slice(0, 10)
  for (let tries = 0; tries < 2 && rows.some((r) => !buyerOf(r)); tries++) {
    const again = await getJson("top-sales?window=7d&sort=price&limit=25")
    const byId = new Map((again.rows ?? []).map((r) => [r.sale_id, r]))
    for (const r of rows) if (!buyerOf(r) && byId.get(r.sale_id) && buyerOf(byId.get(r.sale_id))) r.buyer_name = byId.get(r.sale_id).buyer_name
  }
  // Still an address: ask Dapper directly (same as x-draft.mjs).
  for (const r of rows) {
    if (buyerOf(r)) continue
    const u = await dapperUsername(r.buyer_address)
    if (u) r.buyer_name = u
  }
  const imgs = await Promise.all(
    // Top Shot: the moment's TRANSPARENT render, so every card sits on the card's own glow. The
    // stored thumbnail is a mix — a CDN JPEG on black, or an IPFS PNG that may or may not be
    // transparent (11-09: LeBron and Kawhi on black slabs, Iverson clean) — and is only the fallback.
    rows.map(async (r) =>
      (r.collection === "nba_top_shot" && /^\d+$/.test(String(r.nft_id ?? ""))
        ? padded(await imageData(`https://assets.nbatopshot.com/media/${r.nft_id}/transparent/image?width=600`))
        : null) ??
      (await imageData(r.thumbnail_url)) ??
      (r.collection === "disney_pinnacle" ? await pinnaclePinImage(r) : null),
    ),
  )
  return rows.map((r, i) => {
    if (!imgs[i]) warnings.push(`no image for #${i + 1} ${r.player_name} — its card shows a blank tile`)
    const serial = r.serial_number ? `#${r.serial_number}${r.circulation_count ? `/${r.circulation_count}` : ""}` : ""
    return {
      rank: i + 1,
      collection: r.collection,
      title: r.player_name || shortSet(r.set_name),
      set: [shortSet(r.set_name), r.subedition_name, serial].filter(Boolean).join(" · "),
      price: usd(r.price_usd),
      buyer: buyerOf(r) && (X_HANDLES[buyerOf(r).toLowerCase()] ? `@${X_HANDLES[buyerOf(r).toLowerCase()].replace(/^@/, "")}` : buyerOf(r)),
      img: imgs[i] ? String(imgs[i]) : null,
      padded: !!imgs[i]?.padded,
    }
  })
}

function salesPage({ items, fonts, logo, now }) {
  const from = new Date(now.getTime() - 7 * 86400000)
  const md = (d) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "numeric", day: "numeric" }).format(d)
  const card = (it) => {
    const c = COLL[it.collection] ?? { label: it.collection, accent: "#E03A2F" }
    return `<div class="card" style="--acc:${c.accent}">
      <div class="top"><span class="rank">${it.rank}</span><span class="coll">${esc(SITE_NAMES[it.collection] ?? c.label)}</span></div>
      <div class="art">${it.img ? `<img${it.padded ? ' class="padded"' : ""} src="${it.img}">` : `<span class="noimg">${esc(it.title)}</span>`}</div>
      <div class="name">${esc(it.title)}</div>
      <div class="set">${esc(it.set)}</div>
      <div class="price">${esc(it.price)}</div>
      <div class="buyer">${it.buyer ? `<span>Buyer</span> ${esc(it.buyer)}` : "&nbsp;"}</div>
    </div>`
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Barlow;src:url(data:font/ttf;base64,${fonts.barlow}) format("truetype")}
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${fonts.mono}) format("truetype")}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;background:#080808;color:#F2F2F2;font-family:Barlow,sans-serif;overflow:hidden;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 100% 0%,rgba(224,58,47,.22),transparent 60%),radial-gradient(700px 400px at 0% 100%,rgba(224,58,47,.10),transparent 60%)}
.stripe{position:absolute;left:0;top:0;bottom:0;width:10px;background:#E03A2F}
.wrap{position:absolute;inset:0;padding:22px 40px 18px 50px;display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between}
h1{font-size:54px;line-height:.9;letter-spacing:.5px;text-transform:uppercase}
h1 em{font-style:normal;color:#E03A2F}
.sub{font-family:Mono,monospace;font-size:17px;color:#BFC0BF;margin-top:6px}
.logo{width:80px;height:80px}
.grid{flex:1;display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0 8px;min-height:0}
.card{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.12);border-top:3px solid var(--acc);border-radius:10px;padding:6px 10px 7px;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.art{position:relative;flex:1;min-height:0;border-radius:6px;background:radial-gradient(closest-side,color-mix(in srgb,var(--acc) 22%,transparent),transparent);display:flex;align-items:center;justify-content:center}
.art{overflow:hidden}
.art img{max-width:100%;max-height:100%;object-fit:contain;display:block}
/* Top Shot's transparent render sits inside ~20% empty margin on each side: scale it up to match the cards. */
.art img.padded{transform:scale(1.3)}
.noimg{font-size:30px;line-height:1;text-transform:uppercase;text-align:center;color:color-mix(in srgb,var(--acc) 70%,#fff);opacity:.55;padding:0 8px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}
.rank{font-size:22px;line-height:1;color:#fff;background:#E03A2F;border-radius:6px;padding:3px 7px 2px;min-width:30px;text-align:center}
.coll{font-family:Mono,monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#fff;background:rgba(0,0,0,.65);border:1px solid var(--acc);border-radius:999px;padding:2px 7px}
.name{font-size:21px;line-height:1;text-transform:uppercase;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.set{font-family:Mono,monospace;font-size:11.5px;line-height:1.25;color:#BFC0BF;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.5em}
.price{font-family:Mono,monospace;font-size:24px;color:#fff;margin-top:3px;line-height:1}
.buyer{font-family:Mono,monospace;font-size:12.5px;color:#FF4D40;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.buyer span{color:#8A8A8A}
footer{display:flex;justify-content:space-between;font-family:Mono,monospace;font-size:16px;color:#BFC0BF}
footer b{color:#fff;font-weight:400}
</style></head><body><div class="bg"></div><div class="stripe"></div><div class="wrap">
<header><div><h1>Top sales <em>this week</em></h1><div class="sub">${md(from)} – ${md(now)} · the 10 biggest sales of the last 7 days · USD</div></div>
<img class="logo" src="data:image/png;base64,${logo}"></header>
<div class="grid">${items.map(card).join("")}</div>
<footer><span><b>rippackscity.com/insights/top-sales</b></span><span>@RipPacksCity</span></footer>
</div></body></html>`
}

// The sandbox ships one Chromium with a global Playwright; a repo checkout may carry a different
// Playwright whose browser build is not installed. Try the nearest one, then the global one.
async function launchChromium() {
  const tries = []
  try {
    const { chromium } = await import("playwright")
    return await chromium.launch()
  } catch (e) {
    tries.push(e.message.split("\n")[0])
  }
  try {
    const { execSync } = await import("node:child_process")
    const { createRequire } = await import("node:module")
    const root = execSync("npm root -g", { encoding: "utf8" }).trim()
    const { chromium } = createRequire(join(root, "noop.js"))("playwright")
    return await chromium.launch()
  } catch (e) {
    tries.push(e.message.split("\n")[0])
  }
  throw new Error(`no launchable Chromium: ${tries.join(" | ")}`)
}

async function main() {
  const slot = arg("slot") ?? "sun"
  const outDir = resolve(arg("out") ?? ".")
  mkdirSync(outDir, { recursive: true })
  const out = { slot, images: [], items: [], warnings: [] }
  if (slot === "mon") return monMain(out, outDir)
  if (slot === "big") return bigMain(out, outDir)
  if (slot !== "sun") {
    out.warnings.push(`no image template for slot ${slot} yet — post the text with its link card`)
    console.log(JSON.stringify(out, null, 2))
    return
  }
  const { items, unread } = await dropsItems()
  out.items = items
  if (unread.length) out.warnings.push(`unread sources (their drops are missing from the image): ${unread.join(", ")}`)
  if (!items.length) {
    out.warnings.push("no drop is open or upcoming — no image")
    console.log(JSON.stringify(out, null, 2))
    return
  }
  const fonts = {
    barlow: (await asset("public/fonts/BarlowCondensed-Black.ttf")).toString("base64"),
    mono: (await asset("public/fonts/ShareTechMono-Regular.ttf")).toString("base64"),
  }
  const logo = (await asset("public/rip-packs-city-logo-320.png")).toString("base64")
  const browser = await launchChromium()
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
    const pg = await ctx.newPage()
    const pages = Math.ceil(items.length / PER_IMAGE)
    const now = new Date()
    for (let i = 0; i < pages; i++) {
      const html = page({ items: items.slice(i * PER_IMAGE, (i + 1) * PER_IMAGE), pageNo: i + 1, pages, fonts, logo, now })
      await pg.setContent(html, { waitUntil: "load" })
      await pg.evaluate(() => document.fonts.ready)
      // Every title must be fully visible: a clipped card fails loudly, never ships cut.
      const clipped = await pg.evaluate(() =>
        [...document.querySelectorAll(".card")].filter((c) => c.scrollHeight > c.clientHeight + 1).map((c) => c.querySelector(".title")?.textContent),
      )
      if (clipped.length) out.warnings.push(`image ${i + 1}: text overflows its card for ${clipped.join("; ")}`)
      // And every card must sit inside the canvas, above the footer: a card can fit its own text
      // yet be pushed off the bottom (09-card grid, 11-08), which the per-card check cannot see.
      const offCanvas = await pg.evaluate((h) => {
        const foot = document.querySelector("footer")?.getBoundingClientRect().top ?? h
        return [...document.querySelectorAll(".card")].filter((c) => c.getBoundingClientRect().bottom > Math.min(foot, h) + 1).map((c) => c.querySelector(".title")?.textContent)
      }, H)
      if (offCanvas.length) out.warnings.push(`image ${i + 1}: card pushed off the canvas for ${offCanvas.join("; ")}`)
      const file = join(outDir, `rpc-${slot}-${i + 1}.png`)
      await pg.screenshot({ path: file, type: "png" })
      out.images.push(file)
      writeFileSync(join(outDir, `rpc-${slot}-${i + 1}.html`), html)
    }
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify(out, null, 2))
}

// ---------- big: one big sale (Trevor, 11-14) ----------
// The first one posted: https://x.com/rippackscity/status/2121645350356476091 (Aday Mara Rookie
// Ultimate #1/1, $2,000 — "This season's first Rookie Ultimate sale"). One sale, large: the asset on
// the left (Top Shot: its own moment VIDEO with --video, else its hero still), and on the right the
// headline, player, set · team, the edition's badges and special serials as ICONS ONLY, the price,
// when it sold (PT) and the buyer (same naming rule as Monday: X_HANDLES or the username, untagged).
//
// Badge rules, Trevor 11-14: "We don't need to name out each badge"; "the point of the triple badge
// is that we don't need to then show each of those three badges individually"; "We also don't need
// to call it out being autographed - users can see that". The badge list comes from
// /api/entity/edition-badges (get_edition_badges_unified — already collapses the three rookie
// badges into Three-Star Rookie), the jersey number from /api/entity/edition?part=bio.
//
//   node scripts/social/x-image.mjs --slot big --out /tmp/xdraft                 # the day's first big sale
//   ... --sale <sale_id>                    # a named sale (x-draft.mjs's breaking[].sale.sale_id)
//   ... --headline "This season's first|Rookie Ultimate sale"   # two lines, the second in red
//   ... --video                             # also an MP4 (Top Shot; needs ffmpeg) — muted on purpose:
//                                           # the moment's audio is NBA game sound
const BIG_SALE_USD = 1000
// Top Shot badge titles -> /api/badge-image names (TOPSHOT_SLUGS there). Autographed is left off on
// purpose (above); a title with no official icon is skipped with a warning, never drawn as text.
const TS_BADGE_ICON = {
  "Three-Star Rookie": "threeStars",
  "Rookie Premiere": "rookiePremiere",
  "Rookie Year": "rookieYear",
  "Rookie Mint": "rookieMint",
  "Rookie of the Year": "rookieOfTheYear",
  "Top Shot Debut": "topShotDebut",
  "Championship Year": "championshipYear",
  "Challenge Reward": "challengeReward",
}
const THREE_STAR_PARTS = new Set(["Rookie Premiere", "Rookie Year", "Rookie Mint"])
const SILENT_BADGES = new Set(["Autographed"])
// The exact Top Shot v2 special-serial glyphs (components/SpecialSerialGlyph.tsx), currentColor.
const SERIAL_GLYPH = {
  first: `<svg viewBox="0 0 12 12" fill="none"><path d="M5.99156 9.59775L4.63256 8.2365L4.18875 8.68087L6.0045 10.5L7.81519 8.68538L7.35844 8.22806L5.99156 9.59775ZM8.68481 4.18538L8.2365 4.63481L9.59044 5.99156L8.21906 7.36631L8.68031 7.82756L10.5 6.00506L8.68481 4.18538ZM3.75112 4.63144L3.31069 4.18988L1.5 6.0045L3.31519 7.82362L3.768 7.36969L2.39269 5.99156L3.75112 4.63144ZM4.18425 3.32363L4.62019 3.76013L5.99156 2.38594L7.37138 3.768L7.81969 3.31912L6.0045 1.5L4.18425 3.32363Z" fill="currentColor"/><path d="M5.92524 8.35632L7.08286 7.19588V4.78782L5.92524 3.62738L3.56555 5.99213H4.92849L5.93255 4.95657L5.92524 5.99157V8.35632Z" fill="currentColor"/></svg>`,
  jersey: `<svg viewBox="0 0 12 12" fill="none"><path d="M10 11H2V10H10V11ZM4.5 1C4.5 1.82843 5.17157 2.5 6 2.5C6.82843 2.5 7.5 1.82843 7.5 1H8.5V3.5C8.5 4.32843 9.17157 5 10 5V9H2V5C2.82843 5 3.5 4.32843 3.5 3.5V1H4.5Z" fill="currentColor"/></svg>`,
  perfect: `<svg viewBox="0 0 12 12" fill="none"><path d="M5.96734 4.35638C5.75125 4.35999 5.53804 4.4065 5.34009 4.49322C5.14213 4.57993 4.96338 4.70512 4.81421 4.8615C4.66424 5.01682 4.54659 5.20037 4.46809 5.4015C4.38959 5.60263 4.35179 5.81734 4.3569 6.03319C4.36621 6.46879 4.54791 6.88292 4.86216 7.18472C5.17641 7.48652 5.59753 7.65136 6.03315 7.64306C6.2491 7.63945 6.46218 7.59299 6.66004 7.50637C6.85789 7.41976 7.03657 7.29472 7.18571 7.1385C7.48946 6.82182 7.65259 6.40613 7.64359 5.96681C7.63443 5.53111 7.45279 5.11685 7.13853 4.81492C6.82427 4.513 6.40306 4.34809 5.96734 4.35638Z" fill="currentColor"/><path d="M8.16114 3.81751C7.87481 3.53315 7.53507 3.30823 7.16147 3.1557C6.78787 3.00317 6.38779 2.92605 5.98426 2.92876C5.58093 2.9298 5.1818 3.01072 4.80991 3.16683C4.43802 3.32294 4.10073 3.55116 3.81751 3.83832C3.53315 4.12465 3.30823 4.46439 3.1557 4.83799C3.00317 5.21159 2.92605 5.61167 2.92876 6.0152C2.92988 6.4187 3.01093 6.81798 3.16724 7.18998C3.32355 7.56198 3.55202 7.89932 3.83945 8.18251C4.41375 8.75284 5.19063 9.07241 6.00001 9.07126H6.01576C6.41936 9.07022 6.81875 8.9892 7.19085 8.83289C7.56295 8.67658 7.90038 8.44807 8.18364 8.16057C8.468 7.87425 8.69291 7.53451 8.84544 7.16091C8.99797 6.78731 9.0751 6.38723 9.07239 5.9837C9.07087 5.58026 8.98963 5.1811 8.83335 4.80915C8.67706 4.43721 8.4488 4.09982 8.1617 3.81639M7.87764 7.85739C7.63404 8.10456 7.34388 8.30103 7.02393 8.43542C6.70397 8.56981 6.36055 8.63948 6.01351 8.64039H6.00001C5.30387 8.64182 4.63563 8.36688 4.14207 7.87595C3.89496 7.63242 3.69854 7.34235 3.56415 7.0225C3.42976 6.70264 3.36006 6.35933 3.35907 6.01239C3.35651 5.66533 3.42274 5.3212 3.55395 4.99989C3.68516 4.67857 3.87874 4.38645 4.12351 4.14039C4.36704 3.89327 4.65711 3.69685 4.97696 3.56246C5.29682 3.42807 5.64013 3.35837 5.98707 3.35739H6.00114C6.70145 3.35739 7.3607 3.62851 7.85907 4.12182C8.10619 4.36535 8.30261 4.65542 8.437 4.97528C8.57139 5.29513 8.64109 5.63844 8.64207 5.98539C8.64464 6.33245 8.5784 6.67657 8.4472 6.99789C8.31599 7.3192 8.1224 7.61133 7.87764 7.85739ZM10.1462 4.24839C10.0325 3.97954 9.8929 3.72239 9.72939 3.48057L9.41889 3.79107C9.7794 4.34828 9.99807 4.98524 10.0558 5.64638C10.1136 6.30752 10.0086 6.97274 9.7502 7.58401C9.65927 7.8006 9.54914 8.00862 9.42114 8.20557L9.73164 8.51607C10.2327 7.77265 10.5002 6.89651 10.5 6.00001C10.5011 5.39828 10.3808 4.80251 10.1462 4.24839ZM4.41601 2.24982C4.91719 2.038 5.45591 1.92934 6.00001 1.93032C6.78335 1.929 7.55026 2.15487 8.20782 2.58057L8.51832 2.27007C7.7749 1.76707 6.89761 1.49881 6.00001 1.50001C5.10168 1.49794 4.22354 1.76648 3.48001 2.27064L3.79051 2.58114C3.98864 2.45214 4.19799 2.34126 4.41601 2.24982ZM7.58457 9.7502C7.08322 9.96209 6.5443 10.0708 6.00001 10.0697C5.2178 10.071 4.45196 9.84572 3.79501 9.42114L3.48395 9.73164C4.22692 10.2336 5.10336 10.5013 6.00001 10.5C6.89929 10.502 7.77829 10.2329 8.52226 9.7277L8.21176 9.4172C8.01298 9.54689 7.80287 9.65835 7.58401 9.7502M1.93032 6.00001C1.92883 5.21673 2.15451 4.44983 2.58001 3.7922L2.26951 3.48114C1.7666 4.22478 1.49853 5.10228 1.50001 6.00001C1.49798 6.89929 1.76713 7.77829 2.27232 8.52226L2.58282 8.21176C2.1556 7.55332 1.92891 6.78491 1.93032 6.00001Z" fill="currentColor"/></svg>`,
}
// Every other collection: the RPC-brand monoline glyphs (the same component's fallback).
const SERIAL_GLYPH_RPC = {
  first: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 14 L8 22 L12 19 L16 22 L15 14"/><circle cx="12" cy="9" r="2.1" fill="currentColor" stroke="none"/></svg>`,
  jersey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/></svg>`,
  perfect: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`,
}
const ENTITY_SLUG = { nba_top_shot: "nba-top-shot", nfl_all_day: "nfl-all-day" }

async function siteJson(path) {
  const r = await fetch(`${SITE}${path}`, { headers: { "user-agent": "rpc-x-calendar/1.0" }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

async function bigSaleItem(warnings) {
  const d = await getJson("top-sales?window=7d&sort=price&limit=200")
  const rows = (d.rows ?? []).filter((r) => r.collection !== "ufc_strike" && r.price_usd > 0)
  const want = arg("sale")
  // Default: x-draft.mjs's breaking() rule — the week's top 5, $1,000+, sold in the last 24 h.
  const r = want
    ? rows.find((x) => x.sale_id === want)
    : rows.slice(0, 5).find((x) => x.price_usd >= BIG_SALE_USD && Date.now() - new Date(x.sold_at) < 86400000)
  if (!r) return null
  if (!buyerOf(r)) {
    const u = await dapperUsername(r.buyer_address)
    if (u) r.buyer_name = u
  }
  const ts = r.collection === "nba_top_shot" && /^\d+$/.test(String(r.nft_id ?? ""))
  const hero = ts ? await imageData(`https://assets.nbatopshot.com/media/${r.nft_id}?type=hero`) : null
  const img =
    hero ??
    (await imageData(r.thumbnail_url)) ??
    (r.collection === "disney_pinnacle" ? await pinnaclePinImage(r) : null)
  if (!img) warnings.push(`no image for ${r.player_name} — the art area is empty`)

  // Edition badges, icons only (Top Shot has the official icon set; other collections skip them).
  const icons = []
  if (ts && r.external_id) {
    try {
      const b = await siteJson(`/api/entity/edition-badges?collection=${ENTITY_SLUG[r.collection]}&slugs=${encodeURIComponent(r.external_id)}`)
      const titles = b.badges?.[r.external_id]
      if (!Array.isArray(titles)) warnings.push(`badges unknown for ${r.external_id} — none drawn`)
      else {
        const three = titles.includes("Three-Star Rookie")
        for (const t of titles) {
          if (SILENT_BADGES.has(t) || (three && THREE_STAR_PARTS.has(t))) continue
          const name = TS_BADGE_ICON[t]
          const icon = name ? await imageData(`${SITE}/api/badge-image?name=${name}&v=2`) : null
          if (icon) icons.push(icon)
          else warnings.push(`badge "${t}" has no icon — left off the image`)
        }
      }
    } catch (e) {
      warnings.push(`badges unread (${e.message}) — none drawn`)
    }
  }
  // Special serials: #1, perfect (#N/N, the last mint), jersey match.
  const serials = []
  const sn = Number(r.serial_number) || null
  if (sn === 1) serials.push("first")
  if (sn && Number(r.circulation_count) === sn) serials.push("perfect")
  if (sn && ENTITY_SLUG[r.collection] && r.external_id) {
    try {
      const bio = await siteJson(`/api/entity/edition?collection=${ENTITY_SLUG[r.collection]}&editionKey=${encodeURIComponent(r.external_id)}&part=bio`)
      if (bio.jerseyNumber != null && Number(bio.jerseyNumber) === sn) serials.push("jersey")
    } catch (e) {
      warnings.push(`jersey number unread (${e.message}) — jersey serial not checked`)
    }
  }
  const buyer = buyerOf(r)
  if (!buyer) warnings.push("buyer known only by wallet — left off the image")
  const sold = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).formatToParts(new Date(r.sold_at))
  const p = Object.fromEntries(sold.map((x) => [x.type, x.value]))
  return {
    sale_id: r.sale_id,
    collection: r.collection,
    nft_id: r.nft_id,
    title: r.player_name || shortSet(r.set_name),
    set: [shortSet(r.set_name), r.subedition_name, r.team_name].filter(Boolean).join(" · "),
    serial: sn ? `#${sn}${r.circulation_count ? `/${Number(r.circulation_count).toLocaleString("en-US")}` : ""}` : "",
    price: usd(r.price_usd),
    sold: `Sold ${p.weekday} ${p.month}/${p.day} · ${p.hour}:${p.minute} ${p.dayPeriod} PT`,
    buyer: buyer && (X_HANDLES[buyer.toLowerCase()] ? `@${X_HANDLES[buyer.toLowerCase()].replace(/^@/, "")}` : buyer),
    img: img ? String(img) : null,
    // A Top Shot hero is the moment on black: blended + feathered into the page. Anything else is a
    // card or pin with its own edges, shown whole.
    onBlack: !!hero,
    icons,
    serials,
  }
}

// Art box in CSS px (1200×675). The video pass renders the page with no art at 1.6× (1920×1080) and
// lays the video into the same box; the 74px gap to the text is Trevor's, 11-14 ("a little bit more
// of a spacing gap between the video and the text").
const BIG_ART = { x: 36, y: 47, size: 580 }
function bigPage({ it, fonts, logo, art }) {
  const c = COLL[it.collection] ?? { label: it.collection, accent: "#E03A2F" }
  const [h1a, h1b] = (arg("headline") ?? "One of the week's|top sales").split("|")
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Barlow;src:url(data:font/ttf;base64,${fonts.barlow}) format("truetype")}
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${fonts.mono}) format("truetype")}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;background:#080808;color:#F2F2F2;font-family:Barlow,sans-serif;overflow:hidden;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 100% 0%,rgba(224,58,47,.22),transparent 60%),radial-gradient(700px 400px at 100% 100%,rgba(224,58,47,.08),transparent 60%)}
.stripe{position:absolute;left:0;top:0;bottom:0;width:10px;background:#E03A2F}
.art{position:absolute;left:${BIG_ART.x}px;top:${BIG_ART.y}px;width:${BIG_ART.size}px;height:${BIG_ART.size}px}
.art img{width:100%;height:100%;object-fit:contain}
.art img.blend{mix-blend-mode:screen;-webkit-mask-image:radial-gradient(closest-side,#000 82%,transparent);mask-image:radial-gradient(closest-side,#000 82%,transparent)}
.txt{position:absolute;left:690px;right:48px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center}
.kick{font-family:Mono,monospace;font-size:17px;letter-spacing:2px;text-transform:uppercase;color:#FF4D40}
h1{font-size:50px;line-height:.92;text-transform:uppercase;margin-top:12px}
h1 em{font-style:normal;color:#E03A2F}
.rule{height:2px;background:linear-gradient(90deg,#E03A2F,transparent);margin:18px 0 16px}
.name{font-size:46px;line-height:1;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.set{font-family:Mono,monospace;font-size:19px;color:#BFC0BF;margin-top:8px}
.badges{display:flex;align-items:center;gap:12px;margin-top:16px;min-height:38px}
.b3{height:38px;width:auto}
.sep{width:1px;height:30px;background:rgba(255,255,255,.25);margin:0 4px}
.ser{font-family:Mono,monospace;font-size:26px;color:#fff;letter-spacing:1px}
.sg{display:inline-flex;width:34px;height:34px;color:#FF4D40}.sg svg{width:100%;height:100%}
.price{font-family:Mono,monospace;font-size:78px;line-height:1;color:#fff;margin-top:18px}
.meta{font-family:Mono,monospace;font-size:16px;color:#BFC0BF;margin-top:12px}
.buyer{font-family:Mono,monospace;font-size:22px;color:#FF4D40;margin-top:14px}.buyer span{color:#8A8A8A}
.logo{position:absolute;right:40px;top:26px;width:72px;height:72px}
footer{position:absolute;left:50px;right:40px;bottom:18px;display:flex;justify-content:space-between;font-family:Mono,monospace;font-size:16px;color:#BFC0BF}
footer b{color:#fff;font-weight:400}
</style></head><body><div class="bg"></div><div class="stripe"></div>
${art && it.img ? `<div class="art"><img${it.onBlack ? ' class="blend"' : ""} src="${it.img}"></div>` : ""}
<img class="logo" src="data:image/png;base64,${logo}">
<div class="txt">
 <div class="kick">${esc(c.label)} · Big sale</div>
 <h1>${esc(h1a)}${h1b ? `<br><em>${esc(h1b)}</em>` : ""}</h1>
 <div class="rule"></div>
 <div class="name">${esc(it.title)}</div>
 <div class="set">${esc(it.set)}</div>
 <div class="badges">${it.icons.map((s) => `<img class="b3" src="${s}">`).join("")}${it.icons.length && it.serial ? `<span class="sep"></span>` : ""}${it.serial ? `<span class="ser">${esc(it.serial)}</span>` : ""}${it.serials.map((k) => `<i class="sg">${(it.collection === "nba_top_shot" ? SERIAL_GLYPH : SERIAL_GLYPH_RPC)[k]}</i>`).join("")}</div>
 <div class="price">${esc(it.price)}</div>
 <div class="meta">${esc(it.sold)}</div>
 ${it.buyer ? `<div class="buyer"><span>Bought by</span> ${esc(it.buyer)}</div>` : ""}
</div>
<footer><span><b>rippackscity.com/insights/top-sales</b></span><span>@RipPacksCity</span></footer>
</body></html>`
}

async function bigMain(out, outDir) {
  const it = await bigSaleItem(out.warnings)
  if (!it) {
    out.warnings.push(arg("sale") ? `sale ${arg("sale")} is not on the 7-day board — no image` : "no big sale in the last 24 h — no image")
    console.log(JSON.stringify(out, null, 2))
    return
  }
  const { img, icons, onBlack, ...meta } = it
  out.items = [{ ...meta, badge_icons: icons.length }]
  const fonts = {
    barlow: (await asset("public/fonts/BarlowCondensed-Black.ttf")).toString("base64"),
    mono: (await asset("public/fonts/ShareTechMono-Regular.ttf")).toString("base64"),
  }
  const logo = (await asset("public/rip-packs-city-logo-320.png")).toString("base64")
  const wantVideo = process.argv.includes("--video")
  const browser = await launchChromium()
  try {
    const shoot = async (scale, art, file) => {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: scale })
      const pg = await ctx.newPage()
      await pg.setContent(bigPage({ it, fonts, logo, art }), { waitUntil: "load" })
      await pg.evaluate(() => document.fonts.ready)
      const bad = await pg.evaluate(() => {
        const t = document.querySelector(".txt").getBoundingClientRect()
        const foot = document.querySelector("footer").getBoundingClientRect().top
        const kids = [...document.querySelectorAll(".txt > *")]
        return {
          off: kids.filter((k) => k.getBoundingClientRect().right > t.right + 1 || k.getBoundingClientRect().bottom > foot).map((k) => k.className),
          cut: [...document.querySelectorAll(".name")].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
        }
      })
      if (bad.off.length) out.warnings.push(`text runs off its column: ${bad.off.join(", ")}`)
      if (bad.cut.length) out.warnings.push(`name ellipsized: ${bad.cut.join("; ")}`)
      await pg.screenshot({ path: file, type: "png" })
      await ctx.close()
    }
    const still = join(outDir, "rpc-big-1.png")
    await shoot(2, true, still)
    out.images.push(still)
    if (wantVideo) {
      const { spawnSync } = await import("node:child_process")
      if (it.collection !== "nba_top_shot") out.warnings.push("--video: only Top Shot moments have a video — still image only")
      else if (spawnSync("ffmpeg", ["-version"]).status !== 0) out.warnings.push("--video: ffmpeg is not installed — still image only")
      else {
        const vr = await fetch(`https://assets.nbatopshot.com/media/${it.nft_id}?type=video`, { signal: AbortSignal.timeout(60_000) }).catch(() => null)
        if (!vr?.ok || !String(vr.headers.get("content-type")).startsWith("video/")) out.warnings.push("--video: the moment video could not be fetched — still image only")
        else {
          const src = join(outDir, "rpc-big-src.mp4")
          writeFileSync(src, Buffer.from(await vr.arrayBuffer()))
          const base = join(outDir, "rpc-big-base.png")
          await shoot(1.6, false, base)
          const s = 1.6
          const [x, y, n] = [Math.round(BIG_ART.x * s), Math.round(BIG_ART.y * s), Math.round(BIG_ART.size * s)]
          const file = join(outDir, "rpc-big-1.mp4")
          // The video's black surround is blended away (lighten) so it sits on the page's own background.
          const ff = spawnSync("ffmpeg", [
            "-v", "error", "-y", "-loop", "1", "-framerate", "30", "-i", base, "-i", src,
            "-filter_complex",
            `[0:v]format=gbrp,split[b1][b2];[b2]crop=${n}:${n}:${x}:${y}[bc];[1:v]scale=${n}:${n},format=gbrp[v];[bc][v]blend=all_mode=lighten:shortest=1[art];[b1][art]overlay=${x}:${y}:shortest=1,format=yuv420p[out]`,
            "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-r", "30", "-movflags", "+faststart", file,
          ], { encoding: "utf8", timeout: 540_000 })
          for (const tmp of [src, base]) rmSync(tmp, { force: true })
          if (ff.status === 0) out.images.push(file)
          else out.warnings.push(`--video: ffmpeg failed (${String(ff.stderr).trim().split("\n").pop()}) — still image only`)
        }
      }
    }
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify(out, null, 2))
}

// One image, 10 cards. A name or set too long for its card is ellipsized; a card pushed off the
// canvas fails loudly as on Sunday.
async function monMain(out, outDir) {
  const items = await topSalesItems(out.warnings)
  out.items = items.map(({ img, ...it }) => it)
  if (!items.length) {
    out.warnings.push("no sales on the 7-day board — no image")
    console.log(JSON.stringify(out, null, 2))
    return
  }
  const fonts = {
    barlow: (await asset("public/fonts/BarlowCondensed-Black.ttf")).toString("base64"),
    mono: (await asset("public/fonts/ShareTechMono-Regular.ttf")).toString("base64"),
  }
  const logo = (await asset("public/rip-packs-city-logo-320.png")).toString("base64")
  const browser = await launchChromium()
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 })
    const pg = await ctx.newPage()
    const html = salesPage({ items, fonts, logo, now: new Date() })
    await pg.setContent(html, { waitUntil: "load" })
    await pg.evaluate(() => document.fonts.ready)
    const bad = await pg.evaluate((h) => {
      const foot = document.querySelector("footer")?.getBoundingClientRect().top ?? h
      const off = [...document.querySelectorAll(".card")].filter((c) => c.getBoundingClientRect().bottom > Math.min(foot, h) + 1)
      const cut = [...document.querySelectorAll(".name")].filter((n) => n.scrollWidth > n.clientWidth + 1)
      const tiny = [...document.querySelectorAll(".art")].filter((a) => a.getBoundingClientRect().height < 60)
      return { off: off.map((c) => c.querySelector(".name")?.textContent), cut: cut.map((n) => n.textContent), tiny: tiny.length }
    }, H)
    if (bad.off.length) out.warnings.push(`card pushed off the canvas for ${bad.off.join("; ")}`)
    if (bad.cut.length) out.warnings.push(`name ellipsized on the image: ${bad.cut.join("; ")}`)
    if (bad.tiny) out.warnings.push(`${bad.tiny} card image(s) squeezed under 60px`)
    const file = join(outDir, "rpc-mon-1.png")
    await pg.screenshot({ path: file, type: "png" })
    writeFileSync(join(outDir, "rpc-mon-1.html"), html)
    out.images.push(file)
  } finally {
    await browser.close()
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.log(JSON.stringify({ images: [], warnings: [`image failed: ${e.message}`] }, null, 2))
  process.exitCode = 1
})
