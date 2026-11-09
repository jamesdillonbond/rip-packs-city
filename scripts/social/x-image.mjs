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
//
// House rules (same as the text): dollars only, never "DUC"; no FMV confidence; Pinnacle assets
// are characters; no UFC. Drops (sun): brand art only — no pack art or partner artwork.
// Top sales (mon): each sale shows its asset's own image, price and buyer username (Trevor, 11-09);
// a buyer known only by wallet address is left blank, never printed as the address.

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
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
