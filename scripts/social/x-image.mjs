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
//
// Prints JSON: { slot, images: [paths], items, warnings }. Every item in the post is on an image —
// a list longer than one image fits is split across images (X allows 4 per post), never cut.
//
// House rules (same as the text): dollars only, never "DUC"; no FMV confidence; Pinnacle assets
// are characters; no collector names; no UFC. Brand art only: no pack art, player photos or
// partner artwork is ever composited in (those belong to their owners) — the image is RPC's own.

import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SITE = "https://www.rippackscity.com"
const API = `${SITE}/api/public/insights`
const RAW = "https://raw.githubusercontent.com/jamesdillonbond/rip-packs-city/main"
const TZ = "America/Los_Angeles"
const PER_IMAGE = 8
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
  const word = x.collection === "disney_pinnacle" ? "Draw requests" : "Pre-orders"
  if (x.status === "upcoming") return `${x.kind === "rsvp" ? `${word} open` : "Drops"} ${whenPT(x.start_time)}`
  if (x.kind === "rsvp" && x.end_time) return `${word} close ${whenPT(x.end_time)}`
  return x.end_time ? `On sale until ${whenPT(x.end_time)}` : "On sale now"
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
  }))
  for (const a of d.announcements ?? []) items.push({ collection: "candy_mlb", title: a.title, price: null, status: "Announced", upcoming: false })
  return { items, unread }
}

function card(it, big) {
  const c = COLL[it.collection] ?? { label: it.collection, accent: "#E03A2F" }
  return `<div class="card${big ? " big" : ""}" style="--acc:${c.accent}">
    <div class="chip"><span class="dot"></span>${esc(c.label)}</div>
    <div class="title">${esc(it.title)}</div>
    <div class="row">${it.price ? `<span class="price">${esc(it.price)}</span>` : ""}<span class="when${it.upcoming ? " soon" : ""}">${esc(it.status)}</span></div>
  </div>`
}

function page({ items, pageNo, pages, fonts, logo, now }) {
  const n = items.length
  const cols = n <= 2 ? n : n <= 4 ? 2 : n <= 6 ? 3 : 4
  const rows = Math.ceil(n / cols)
  const range = `${dayPT(now)} – ${dayPT(new Date(now.getTime() + 7 * 86400000))}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Barlow;src:url(data:font/ttf;base64,${fonts.barlow}) format("truetype")}
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${fonts.mono}) format("truetype")}
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;height:${H}px;background:#080808;color:#F2F2F2;font-family:Barlow,sans-serif;overflow:hidden;position:relative}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 100% 0%,rgba(224,58,47,.22),transparent 60%),radial-gradient(700px 400px at 0% 100%,rgba(224,58,47,.10),transparent 60%)}
.stripe{position:absolute;left:0;top:0;bottom:0;width:10px;background:#E03A2F}
.wrap{position:absolute;inset:0;padding:34px 44px 30px 54px;display:flex;flex-direction:column}
header{display:flex;align-items:center;justify-content:space-between}
h1{font-size:70px;line-height:.9;letter-spacing:.5px;text-transform:uppercase}
h1 em{font-style:normal;color:#E03A2F}
.sub{font-family:Mono,monospace;font-size:19px;color:#BFC0BF;margin-top:8px}
.logo{width:104px;height:104px}
.grid{flex:1;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:14px;margin:22px 0 16px}
.card{background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.12);border-top:4px solid var(--acc);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;min-width:0}
.chip{font-family:Mono,monospace;font-size:14px;color:#BFC0BF;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:8px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--acc)}
.title{font-size:${cols >= 4 ? 30 : 36}px;line-height:1.02;text-transform:uppercase;margin:8px 0 auto;overflow-wrap:anywhere}
.row{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.price{font-family:Mono,monospace;font-size:${cols >= 4 ? 30 : 36}px;color:#fff}
.when{font-family:Mono,monospace;font-size:${cols >= 4 ? 15 : 18}px;color:#FF4D40}
.when.soon{color:#FBBF24}
footer{display:flex;justify-content:space-between;font-family:Mono,monospace;font-size:17px;color:#BFC0BF}
footer b{color:#fff;font-weight:400}
</style></head><body><div class="bg"></div><div class="stripe"></div><div class="wrap">
<header><div><h1>Drops <em>this week</em></h1><div class="sub">${esc(range)} · every drop open now or starting soon · times PT · retail prices${pages > 1 ? ` · ${pageNo}/${pages}` : ""}</div></div>
<img class="logo" src="data:image/png;base64,${logo}"></header>
<div class="grid">${items.map((it) => card(it)).join("")}</div>
<footer><span><b>rippackscity.com</b></span><span>@RipPacksCity</span></footer>
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

main().catch((e) => {
  console.log(JSON.stringify({ images: [], warnings: [`image failed: ${e.message}`] }, null, 2))
  process.exitCode = 1
})
