#!/usr/bin/env node
// scripts/ipfs-thumb-mirror.mjs
//
// Backfill the durable mirror of resized IPFS art that /api/public/ipfs-thumb serves FIRST.
//
// WHY (2026-11-01): UFC Strike art lives only on public IPFS (582 CIDs on ipfs.io, none pinned on
// Dapper's gateway), and the public gateways stopped answering inside a page request's budget —
// Pinata timing out, ipfs.io / dweb.link / w3s.link / nftstorage.link all 429. A batch job can
// afford what a render cannot: a 60 s timeout per gateway, sequential fallback, backoff on 429,
// and several rounds. Whatever it wins is kept, so a reader never waits on a gateway again.
//
// For every CID on an `editions.thumbnail_url` at https://ipfs.io/ipfs/<cid> that is missing any
// width in the mirror: download the original once, resize to EVERY width, upload `<cid>/<w>.webp`.
// ⚠ The resize MUST match the route's (rotate, width, withoutEnlargement, webp q78) and the keys
// MUST match lib/ipfs-media.ts ipfsThumbMirrorKey — __tests__/ipfs-thumb-mirror.test.ts pins both.
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Flags: --cid <cid> (just one), --limit <n>, --dry-run (report what is missing; write nothing),
//        --budget-min <n> (stop STARTING new CIDs after n minutes; default 330 — see BUDGET below).
//
// ⚠ BUDGET (2026-11-01, measured on the first full run): the CIDs a gateway serves go fast (~300 in
// 15 min); the rest each burn up to 3 rounds x the two slow gateways' 60 s timeouts. A run killed by
// the job's timeout-minutes prints NOTHING, so the summary naming what is still missing would be
// lost. The script stops taking new work at the budget and reports instead.
// Exit: 0 when every CID is mirrored at the end; 1 if any CID is still missing (named in the summary).

import sharp from "sharp"
import { pathToFileURL } from "node:url"

export const BUCKET = "ipfs-thumbs"
export const WIDTHS = [160, 320, 640, 960]
export const mirrorKey = (cid, width) => `${cid}/${width}.webp`
export const resizeToWebp = (input, width) =>
  sharp(input, { limitInputPixels: 60_000_000 }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer()

// Ordered by the 2026-11-01 pg_net probe (Pinata 2/3, Filebase 1/3); the rest are last resorts.
export const GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.filebase.io/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://ipfs.dapperlabs.com/ipfs/",
]
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{40,})$/
const IPFS_IO_RE = /^https:\/\/ipfs\.io\/ipfs\/([A-Za-z0-9]+)$/
const GATEWAY_TIMEOUT_MS = 60_000
const ROUNDS = 3
const CONCURRENCY = 4
const MAX_INPUT_BYTES = 40 * 1024 * 1024

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")
  return { url, key, headers: { Authorization: `Bearer ${key}`, apikey: key } }
}

/** Every distinct ipfs.io thumbnail CID in `editions`. A failed page THROWS — never a partial list. */
async function listCids({ url, headers }) {
  const cids = new Set()
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(
      `${url}/rest/v1/editions?select=id,thumbnail_url&thumbnail_url=like.https://ipfs.io/ipfs/*&order=id.asc`,
      { headers: { ...headers, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" } },
    )
    if (!res.ok) throw new Error(`editions read failed at offset ${from}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    const rows = await res.json()
    for (const r of rows) {
      const m = String(r.thumbnail_url ?? "").match(IPFS_IO_RE)
      if (m && CID_RE.test(m[1])) cids.add(m[1])
    }
    if (rows.length < PAGE) break
  }
  return [...cids]
}

/** Widths already in the mirror for this CID. A failed list THROWS (unknown is not "none"). */
async function mirroredWidths({ url, headers }, cid) {
  const res = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: `${cid}/`, limit: 100, offset: 0 }),
  })
  if (!res.ok) throw new Error(`mirror list failed cid=${cid}: HTTP ${res.status}`)
  const have = new Set()
  for (const o of await res.json()) {
    const m = String(o.name ?? "").match(/^(\d+)\.webp$/)
    if (m) have.add(Number(m[1]))
  }
  return have
}

/** The original's bytes from the first gateway that serves an image, or null with every attempt named. */
async function download(cid, log) {
  const attempts = []
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const base of GATEWAYS) {
      const host = new URL(base).host
      try {
        const res = await fetch(`${base}${cid}`, {
          headers: { "User-Agent": "rip-packs-city/ipfs-thumb-mirror" },
          signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
        })
        const type = res.headers.get("content-type") ?? ""
        if (!res.ok || !type.startsWith("image/")) {
          res.body?.cancel().catch(() => {})
          attempts.push(`${host}:${res.status}${res.ok ? `:${type || "notype"}` : ""}`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength > MAX_INPUT_BYTES) { attempts.push(`${host}:too_large`); continue }
        return { buf, host }
      } catch (err) {
        attempts.push(`${host}:${err?.name === "TimeoutError" ? "timeout" : "error"}`)
      }
    }
    await sleep(5_000 * (round + 1))
  }
  log(`  ✗ ${cid} no gateway served it: ${attempts.join(" ")}`)
  return null
}

async function upload({ url, headers }, cid, width, bytes) {
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${mirrorKey(cid, width)}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "image/webp", "Cache-Control": "31536000", "x-upsert": "true" },
    body: bytes,
  })
  if (!res.ok) throw new Error(`upload failed ${mirrorKey(cid, width)}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1] }
  const dryRun = args.includes("--dry-run")
  const onlyCid = flag("--cid")
  const limit = flag("--limit") ? Number(flag("--limit")) : Infinity
  const budgetMs = (flag("--budget-min") ? Number(flag("--budget-min")) : 330) * 60_000
  const deadline = Date.now() + budgetMs
  if (onlyCid && !CID_RE.test(onlyCid)) throw new Error(`not a CID: ${onlyCid}`)

  const e = env()
  const all = onlyCid ? [onlyCid] : await listCids(e)
  console.log(`[ipfs-thumb-mirror] ${all.length} CIDs inspected${onlyCid ? " (--cid)" : " from editions.thumbnail_url on ipfs.io"}`)
  if (!onlyCid && all.length === 0) throw new Error("inspected 0 CIDs — the editions read returned nothing; refusing to report success")

  const todo = []
  for (const cid of all) {
    const have = await mirroredWidths(e, cid)
    const missing = WIDTHS.filter((w) => !have.has(w))
    if (missing.length) todo.push({ cid, missing })
  }
  const queue = todo.slice(0, limit)
  console.log(`[ipfs-thumb-mirror] already complete ${all.length - todo.length}, missing ≥1 width ${todo.length}, this run ${queue.length}${dryRun ? " (dry run)" : ""}`)
  if (dryRun) return 0

  let mirrored = 0, objects = 0
  const failed = []
  const gatewayWins = {}
  let next = 0
  let outOfBudget = false
  async function worker() {
    while (next < queue.length) {
      if (Date.now() > deadline) { outOfBudget = true; return }
      const { cid, missing } = queue[next++]
      const got = await download(cid, console.log)
      if (!got) { failed.push(cid); continue }
      try {
        for (const w of missing) {
          await upload(e, cid, w, await resizeToWebp(got.buf, w))
          objects += 1
        }
        mirrored += 1
        gatewayWins[got.host] = (gatewayWins[got.host] ?? 0) + 1
        console.log(`  ✓ ${cid} via ${got.host} (${missing.join(",")})`)
      } catch (err) {
        console.log(`  ✗ ${cid} ${err instanceof Error ? err.message : String(err)}`)
        failed.push(cid)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const stillMissing = todo.length - mirrored
  console.log(JSON.stringify({ inspected: all.length, needed: todo.length, queued: queue.length, attempted: next, mirrored_cids: mirrored, objects_written: objects, failed_cids: failed.length, out_of_budget: outOfBudget, not_attempted: queue.length - next, still_missing_cids: stillMissing, gateway_wins: gatewayWins, failed }, null, 1))
  return stillMissing > 0 ? 1 : 0
}

// Windows-safe main-module check (see __tests__/scripts-main-module-guard-works-on-windows.test.ts).
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => { console.error(`[ipfs-thumb-mirror] FAILED: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) })
}
