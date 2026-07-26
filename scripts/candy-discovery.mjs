// scripts/candy-discovery.mjs
//
// Item 0 discovery for Candy (Solana / Metaplex Core) — run on DROP DAY after
// assets land in a wallet. Pulls every asset in the wallet through the
// helius-proxy worker and prints the on-chain shapes that the discovery-coupled
// constants in lib/chains/solana/normalize.ts are derived from:
//
//   CANDY_MLB_COLLECTION_ADDRESS — the grouping group_value
//   SERIAL_ATTR_KEY              — candidate serial trait keys
//   EDITION_SIZE_ATTR_KEY        — candidate edition-size trait keys
//   editionKeyFromAsset()        — name patterns + which traits are
//                                  constant across serials of one card
//   (CANDY_MLB_ME_SYMBOL, the Magic Eden symbol, comes from ME once secondary opens.)
//
// STATUS: Drop-1 discovery is COMPLETE (2026-07-17) — all of the above are
// resolved live in lib/chains/solana/normalize.ts (the source of truth; pinned
// by __tests__/solana-normalize.test.ts). This script stays as the reusable
// drop-day recon tool: re-run it against a fresh wallet for the NEXT drop and
// diff the printed values against normalize.ts before touching any constant.
//
// Usage (PowerShell, from repo root):
//   $env:HELIUS_PROXY_URL    = "https://helius-proxy.tdillonbond.workers.dev/"
//   $env:HELIUS_PROXY_SECRET = "<the secret>"
//   node scripts/candy-discovery.mjs 63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY
//
// Read-only. Writes the raw asset JSON to candy-discovery-<wallet8>.json next
// to the repo root for archival / deeper inspection. Never prints secrets.

const PROXY_URL = process.env.HELIUS_PROXY_URL || ""
const PROXY_SECRET = process.env.HELIUS_PROXY_SECRET || ""
const wallet = process.argv[2]

if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
  console.error("Usage: node scripts/candy-discovery.mjs <solana-wallet-base58>")
  process.exit(1)
}
if (!PROXY_URL || !PROXY_SECRET) {
  console.error("Set HELIUS_PROXY_URL and HELIUS_PROXY_SECRET env vars first (values never printed).")
  process.exit(1)
}

async function dasCall(method, params) {
  const resp = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Proxy-Secret": PROXY_SECRET },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!resp.ok) throw new Error(`${method} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  const json = await resp.json()
  if (json.error) throw new Error(`${method} RPC error: ${json.error.message ?? "unknown"}`)
  return json.result
}

const assets = []
for (let page = 1; page <= 20; page++) {
  const r = await dasCall("getAssetsByOwner", { ownerAddress: wallet, page, limit: 1000 })
  assets.push(...(r?.items ?? []))
  if (!r?.items?.length || r.items.length < 1000) break
}

console.log(`\nTOTAL assets in wallet: ${assets.length}`)
if (!assets.length) {
  console.log("Wallet is empty on-chain — Candy hasn't minted yet. Re-run after buying a pack.")
  process.exit(0)
}

// Archive raw JSON for deeper inspection.
const { writeFileSync } = await import("node:fs")
const outFile = `candy-discovery-${wallet.slice(0, 8)}.json`
writeFileSync(outFile, JSON.stringify(assets, null, 2))
console.log(`Raw assets written to ${outFile}\n`)

// ── CANDY_MLB_COLLECTION_ADDRESS: grouping values ───────────────────────────
const groups = new Map()
for (const a of assets) {
  for (const g of a.grouping ?? []) {
    const key = `${g.group_key}=${g.group_value}`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
}
console.log("CANDY_MLB_COLLECTION_ADDRESS — grouping values (collection address = the dominant 'collection' group_value):")
for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${k}`)
if (!groups.size) console.log("  (none — check interface/ownership below; Core assets should carry grouping)")

// ── Interfaces + burnt sanity ───────────────────────────────────────────────
const ifaces = new Map()
let burnt = 0
for (const a of assets) {
  ifaces.set(a.interface ?? "?", (ifaces.get(a.interface ?? "?") ?? 0) + 1)
  if (a.burnt === true) burnt++
}
console.log(`\nInterfaces: ${[...ifaces.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}   burnt=${burnt}`)

// ── SERIAL_ATTR_KEY / EDITION_SIZE_ATTR_KEY: trait keys ─────────────────────
const traitKeys = new Map()
for (const a of assets) {
  for (const t of a.content?.metadata?.attributes ?? []) {
    if (t?.trait_type == null) continue
    const k = String(t.trait_type)
    if (!traitKeys.has(k)) traitKeys.set(k, new Set())
    if (traitKeys.get(k).size < 6) traitKeys.get(k).add(String(t.value))
  }
}
console.log("\nSERIAL_ATTR_KEY / EDITION_SIZE_ATTR_KEY — trait keys seen (with sample values):")
for (const [k, vals] of traitKeys.entries()) console.log(`  ${k}: ${[...vals].join(" | ")}`)
console.log("  → serial key = the one that differs per asset; edition-size key = the constant '/250'-style one")

// ── editionKeyFromAsset: name patterns + edition grouping ───────────────────
console.log("\neditionKeyFromAsset — asset names (first 12) — find the per-serial suffix + whether Rainbow color is in the name:")
for (const a of assets.slice(0, 12)) console.log(`  ${a.content?.metadata?.name ?? "(no name)"}  [${a.id.slice(0, 8)}…]`)

// Cross-check against current placeholder derivation: group by stripped-name slug.
const slug = (name) =>
  (name ?? "")
    .replace(/#\s*\d+\s*(\/\s*\d+)?\s*$/i, "")
    .replace(/\b\d+\s*\/\s*\d+\s*$/i, "")
    .trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9:_-]/g, "")
const byKey = new Map()
for (const a of assets) {
  const k = slug(a.content?.metadata?.name) || a.id
  if (!byKey.has(k)) byKey.set(k, [])
  byKey.get(k).push(a)
}
console.log(`\nPlaceholder editionKey groups ${assets.length} assets into ${byKey.size} editions:`)
for (const [k, arr] of [...byKey.entries()].slice(0, 15)) {
  const serials = arr.map((a) => (a.content?.metadata?.attributes ?? []).map((t) => `${t.trait_type}=${t.value}`).join(",")).slice(0, 2)
  console.log(`  ${arr.length}x  ${k}   e.g. ${serials.join(" ; ")}`)
}
console.log("\nSanity: a 10-ICON pack should map to ≈10 editions (or fewer if duplicate players pulled).")
console.log("If Rainbow ICONs are present, confirm they land in a DIFFERENT edition key than the player's Core.")
console.log("\nNext: diff these printed shapes against the resolved constants in lib/chains/solana/normalize.ts. If a NEW drop shifted any of them, update the constant, npx tsc --noEmit, re-run the routes once manually, verify counts. The Magic Eden symbol (CANDY_MLB_ME_SYMBOL) comes from ME once secondary trading opens.")
