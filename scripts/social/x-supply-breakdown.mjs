// scripts/social/x-supply-breakdown.mjs — "Where every Moment sits" graphic (first posted 11-15 as a
// quote post: https://x.com/rippackscity/status/2122082396774547650).
//
// One stacked bar per player: Unlocked · Locked · In packs · Minted, not in packs · Burned.
// Input --data <file.json>: [[player, team, unlocked, locked, in_packs, minted_not_in_packs, burned], …]
// in rank order. Build it with docs/social/supply-breakdown.sql (method + the stale-pack-count trap
// are in docs/social/x-calendar.md § One-off: supply breakdown). Every row must sum to the player's
// circulation; the script prints the totals so the post text can use the same numbers.
//
//   node scripts/social/x-supply-breakdown.mjs --data rows.json --asof "Sun 11/15, 1:09 PM PT" --out supply.png
import { readFileSync } from "node:fs"
import { join } from "node:path"
const ROOT = new URL("../../", import.meta.url).pathname
const F = ROOT + "public/fonts/"
const b64 = (p) => readFileSync(p).toString("base64")
const barlow = b64(F + "BarlowCondensed-Black.ttf"), mono = b64(F + "ShareTechMono-Regular.ttf")
const logoPath = [ROOT + "public/rip-packs-city-logo-320.png"].find((p)=>{try{readFileSync(p);return true}catch{return false}})
const logo = logoPath ? b64(logoPath) : null
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const rows = JSON.parse(readFileSync(arg("data") ?? "data.json", "utf8"))
const ASOF = arg("asof") ?? "today"
const LABEL = arg("label") ?? "2026 rookie class top 10"
const OUT = arg("out") ?? "rpc-supply.png"
const C = [["Unlocked","#3B82F6"],["Locked","#A855F7"],["In packs","#FBBF24"],["Minted, not in packs","#6B7280"],["Burned","#E03A2F"]]
const tot = rows.reduce((a,r)=>{for(let i=0;i<5;i++)a[i]+=r[2+i];return a},[0,0,0,0,0])
const all = tot.reduce((a,b)=>a+b,0)
const row = (r,i) => { const t=r.slice(2).reduce((a,b)=>a+b,0); return `<div class="row"><div class="nm"><span class="rk">${i+1}</span><div><div class="pl">${r[0]}</div><div class="tm">${r[1]} · ${t} Moments</div></div></div>
<div class="bar">${r.slice(2).map((v,k)=>v?`<div class="seg" style="flex:${v};background:${C[k][1]}">${v/t>0.035?v:""}</div>`:"").join("")}</div></div>` }
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Barlow;src:url(data:font/ttf;base64,${barlow})}
@font-face{font-family:Mono;src:url(data:font/ttf;base64,${mono})}
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;height:675px;background:#080808;color:#F2F2F2;font-family:Barlow;position:relative;overflow:hidden}
.bg{position:absolute;inset:0;background:radial-gradient(900px 500px at 100% 0%,rgba(224,58,47,.22),transparent 60%),radial-gradient(700px 400px at 0% 100%,rgba(224,58,47,.10),transparent 60%)}
.stripe{position:absolute;left:0;top:0;bottom:0;width:10px;background:#E03A2F}
.wrap{position:absolute;inset:0;padding:28px 44px 22px 54px;display:flex;flex-direction:column}
header{display:flex;justify-content:space-between;align-items:center}
h1{font-size:52px;line-height:.92;text-transform:uppercase}h1 em{font-style:normal;color:#E03A2F}
.sub{font-family:Mono;font-size:16px;color:#BFC0BF;margin-top:6px}
.logo{width:84px;height:84px}
.legend{display:flex;justify-content:center;gap:22px;font-family:Mono;font-size:15px;color:#E5E5E5;margin:14px 0 10px}
.legend span{display:flex;align-items:center;gap:7px}.legend i{width:13px;height:13px;border-radius:3px;display:inline-block}
.rows{flex:1;display:flex;flex-direction:column;justify-content:space-between}
.row{display:flex;align-items:center;gap:16px}
.nm{width:250px;display:flex;align-items:center;gap:10px}
.rk{font-family:Mono;color:#9CA3AF;font-size:15px;width:22px;text-align:right}
.pl{font-size:21px;line-height:1;text-transform:uppercase}.tm{font-family:Mono;font-size:12px;color:#9CA3AF;margin-top:2px}
.bar{flex:1;height:34px;display:flex;border-radius:8px;overflow:hidden;box-shadow:0 0 0 1px rgba(255,255,255,.08)}
.seg{display:flex;align-items:center;justify-content:center;font-family:Mono;font-size:13px;color:#0B0B0B;font-weight:700;min-width:0}
.tot{display:flex;justify-content:center;gap:26px;font-family:Mono;font-size:15px;color:#E5E5E5;margin-top:12px}
.tot b{color:#fff;font-weight:400}
footer{display:flex;justify-content:space-between;font-family:Mono;font-size:15px;color:#BFC0BF;margin-top:10px}
</style></head><body><div class="bg"></div><div class="stripe"></div><div class="wrap">
<header><div><h1>Where every Moment <em>sits</em></h1><div class="sub">${LABEL} · every Moment minted (${all.toLocaleString()}) · NBA Top Shot · as of ${ASOF}</div></div>${logo?`<img class="logo" src="data:image/png;base64,${logo}">`:""}</header>
<div class="legend">${C.map(([n,c])=>`<span><i style="background:${c}"></i>${n}</span>`).join("")}</div>
<div class="rows">${rows.map(row).join("")}</div>
<div class="tot">${C.map(([n],k)=>`<span>${n}: <b>${tot[k].toLocaleString()}</b></span>`).join("")}</div>
<footer><span>rippackscity.com</span><span>@RipPacksCity</span></footer>
</div></body></html>`
// Same launcher as x-image.mjs: the repo's Playwright first, then the sandbox's global one.
async function launchChromium() {
  const tries = []
  try { const { chromium } = await import("playwright"); return await chromium.launch() } catch (e) { tries.push(e.message.split("\n")[0]) }
  try {
    const { execSync } = await import("node:child_process")
    const { createRequire } = await import("node:module")
    const root = execSync("npm root -g", { encoding: "utf8" }).trim()
    const { chromium } = createRequire(join(root, "noop.js"))("playwright")
    return await chromium.launch()
  } catch (e) { tries.push(e.message.split("\n")[0]) }
  throw new Error(`no launchable Chromium: ${tries.join(" | ")}`)
}
const br = await launchChromium(); const pg = await (await br.newContext({viewport:{width:1200,height:675},deviceScaleFactor:2})).newPage()
await pg.setContent(html); await pg.waitForTimeout(300)
const over = await pg.evaluate(()=>{const f=document.querySelector("footer").getBoundingClientRect();return f.bottom>675})
await pg.screenshot({path:OUT}); await br.close(); console.log(JSON.stringify({tot,all,over,logo:!!logo}))
