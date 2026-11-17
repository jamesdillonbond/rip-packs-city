// scripts/social/supply-breakdown-live-check.js — re-read a supply breakdown LIVE from Top Shot's own
// Atlas API before posting it (first used 11-16 on the 2025 rookie class top 10).
//
// WHY: docs/social/supply-breakdown.sql reads badge_editions (hourly) and RPC's pack-content table,
// whose per-distribution reads can be weeks old. Its in-packs / minted-not-in-packs split is an
// estimate (11-16: 960 / 98 vs 954 / 104 live). Minted, locked, burned and unlocked matched Atlas
// exactly on all 197 editions that day. This script re-reads every number from Atlas so the post uses
// numbers measured at one moment.
//
// HOW: open https://nbatopshot.com in Claude in Chrome (Atlas answers CORS for that origin; the shell
// and Vercel egress are Cloudflare-blocked). Paste EDITIONS / DISTS / NEWEST_DIST from the "Inputs"
// query at the bottom of docs/social/supply-breakdown.sql, run this with javascript_tool, then poll
// `JSON.stringify(window.__supply)` until done:true (91 distributions ≈ 133 calls ≈ 60 s; a single
// javascript_tool call times out at 45 s, which is why it runs in the background).
//
// Output per player: minted, unlocked (owned + listed), locked, in_packs (Σ remainingCount over every
// distribution, hideOpened, capped at hidden per edition), reserve (hidden − in_packs), burned, and
// a check that each row sums to minted. Paste rows into the --data JSON for x-supply-breakdown.mjs.
//
// ⚠ Atlas SearchEditions' setId filter matches by SET NAME: setId 241 and 260 (both "Signature
// Series") each return all 30 editions of both sets. Never sum a per-set walk without de-duplicating
// by edition id — on 11-16 that double-counted 26 editions. This script reads editions by id instead.

const EDITIONS = "12259:Cooper Flagg,12260:Cooper Flagg" // atlas_edition_id:player, comma-separated
const DISTS = "6213,8919"                                // distributions holding any of them unopened
const NEWEST_DIST = 8940                                 // RPC's newest distribution id
const PROBE_NEWER = 20                                   // also probe ids NEWEST_DIST+1 … +20

window.__supply = { done: false, calls: 0, errors: [] }
;(async () => {
  const S = window.__supply
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const post = async (svc, body) => {
    S.calls++
    const r = await fetch("https://api.production.atlas.dapperlabs.com/public/atlas.v1." + svc, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify({ product: "nba", ...body }),
    })
    if (r.status !== 200) throw new Error(svc + " " + r.status)
    return r.json()
  }
  const player = new Map(EDITIONS.split(",").map((p) => { const i = p.indexOf(":"); return [p.slice(0, i), p.slice(i + 1)] }))

  // 1. Edition counts, by id. GetEdition per id is the unambiguous read (no set-name aliasing).
  const ed = new Map()
  for (const id of player.keys()) {
    try {
      const j = await post("EditionService/GetEdition", { editionId: id })
      const e = j.edition ?? j
      ed.set(id, { minted: +e.numMinted || 0, burned: +e.numBurned || 0, locked: +e.numLocked || 0,
                   owned: +e.numOwned || 0, listed: +e.numListed || 0, hidden: +e.numHiddenInPacks || 0 })
    } catch (err) { S.errors.push("edition " + id + ": " + err.message) }
    await sleep(150)
  }

  // 2. Unopened Moments per edition, over every distribution that could hold them.
  const rem = new Map()
  const dists = [...DISTS.split(","), ...Array.from({ length: PROBE_NEWER }, (_, i) => String(NEWEST_DIST + 1 + i))]
  for (const d of dists) {
    let off = 0
    const seen = new Set() // one distribution's rows, across its pages
    for (let page = 0; page < 60; page++) {
      let j
      try { j = await post("DistributionService/GetDistributionEditions", { distributionId: d, limit: "100", offset: String(off), hideOpened: true }) }
      catch (err) { if (!/ 404$/.test(err.message)) S.errors.push("dist " + d + ": " + err.message); break }
      for (const x of j.editions || []) {
        const id = x.edition?.id
        if (!id || seen.has(id) || !player.has(id)) continue
        seen.add(id)
        rem.set(id, (rem.get(id) || 0) + (+x.remainingCount || 0))
        if (Number(d) > NEWEST_DIST) S.errors.push("NEW distribution " + d + " holds edition " + id + " — RPC has not walked it yet")
      }
      off += 100
      if (!(j.editions || []).length || off >= (+j.totalCount || 0)) break
      await sleep(300)
    }
    await sleep(300)
  }

  // 3. Per player.
  const out = {}
  for (const [id, e] of ed) {
    const p = (out[player.get(id)] ??= { editions: 0, minted: 0, unlocked: 0, locked: 0, in_packs: 0, reserve: 0, burned: 0 })
    const inp = Math.min(rem.get(id) || 0, e.hidden)
    if ((rem.get(id) || 0) > e.hidden) S.errors.push("edition " + id + ": remaining " + rem.get(id) + " > hidden " + e.hidden)
    p.editions++; p.minted += e.minted; p.locked += e.locked; p.burned += e.burned
    p.unlocked += e.minted - e.locked - e.burned - e.hidden
    p.in_packs += inp; p.reserve += e.hidden - inp
  }
  for (const p of Object.values(out)) p.sums = p.unlocked + p.locked + p.in_packs + p.reserve + p.burned === p.minted
  S.players = out
  S.read_at = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) + " PT"
  S.done = true
})()
