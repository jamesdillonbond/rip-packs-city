// __tests__/a-wallet-address-is-not-a-profile-handle.test.ts
//
// `/profile/<handle>` resolves an RPC USERNAME only. A link built as
// `/profile/${…address…}` is a 404 for every reader AND for Googlebot.
//
// ── THE CASES (twice) ──────────────────────────────────────────────────────
// 2026-09-06: `WalletLink` (components/entity/_shared.tsx) linked every
// buyer/seller/owner on every sales table to /profile/<address> — Search
// Console showed hundreds of /profile/0x… 404s + noindex rows. Fixed in that
// one helper; nothing guarded the CLASS.
// 2026-10-20: the Special Serial Owners board, written later with its own
// hand-rolled holder link, re-created it — Search Console listed 37
// /profile/0x… 404s crawled Oct 2–10. The fix in one place did not travel.
//
// The page a collector wants behind a wallet is the wallet analyzer,
// /<collection>/collection?wallet=<addr> (anon-public, robots-disallowed via
// `?wallet=`). This walks app/ + components/ + lib/ and bans, at zero, any
// `/profile/${…}` template whose interpolation names an address-shaped field.
// Satisfiable at a population of zero by construction.

import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const ROOT = join(__dirname, "..")
const DIRS = ["app", "components", "lib"]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|jsx?|mjs)$/.test(entry)) out.push(p)
  }
  return out
}

// `/profile/${ <expr mentioning address|addr|wallet|owner|holder> }` —
// excluding `holder_username` / `owner_username`-style fields, which ARE handles.
const OFFENDER = /\/profile\/\$\{([^}]*)\}/g
function offendingExprs(code: string): string[] {
  const hits: string[] = []
  for (const m of code.matchAll(OFFENDER)) {
    const expr = m[1]
    if (/username|handle/i.test(expr)) continue
    if (/address|\baddr\b|wallet|owner|holder|seller|buyer/i.test(expr)) hits.push(expr.trim())
  }
  return hits
}

describe("a wallet address is not a /profile handle", () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)))

  it("inspects a real population (not vacuous)", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("no /profile/${address} href anywhere in app/, components/, lib/", () => {
    const offenders: string[] = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, "utf8"))
      for (const e of offendingExprs(code)) offenders.push(`${f.slice(ROOT.length + 1)}: /profile/\${${e}}`)
    }
    expect(offenders).toEqual([])
  })

  it("planted defects are caught; handle-shaped interpolations are not", () => {
    expect(offendingExprs("href={`/profile/${encodeURIComponent(r.holder_address)}`}")).toHaveLength(1)
    expect(offendingExprs("`/profile/${addr}`")).toHaveLength(1)
    expect(offendingExprs("`/profile/${w.wallet}`")).toHaveLength(1)
    expect(offendingExprs("`/profile/${encodeURIComponent(username)}`")).toHaveLength(0)
    expect(offendingExprs("`/profile/${r.holder_username}`")).toHaveLength(0)
    expect(offendingExprs("`/profile/${data.profileHandle}`")).toHaveLength(0)
  })
})
