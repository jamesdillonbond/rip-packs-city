// 2026-10-25 — wallet links follow the CONTEXT, and both destinations are public.
//
// A signed-out walk of production found public pages linking wallet names into
// /analytics/wallets/* while that section was sign-in only (the click landed on
// /login). The section is public now, and the walk also showed the LINK TARGET was
// wrong for market tables: /analytics/wallets/<a> is the Flowty LOAN profile (a page
// of zeros for a wallet with no loans); a buyer / seller / whale belongs on the
// holdings card, /share/<a>.
//
// Pinned: the two helpers and their destinations; both are anon-public per proxy.ts;
// every market-context call site uses marketWalletHref and the loan-context one
// loanWalletHref; no public-reachable file outside the analytics section hard-codes
// an /analytics/wallets/ link (the loan dashboards inside the section are loan
// contexts and keep theirs).
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isPublicPath } from "@/proxy"
import { marketWalletHref, loanWalletHref } from "@/lib/analytics/wallet-href"

const ROOT = join(__dirname, "..")
const read = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

describe("wallet link helpers", () => {
  it("market → holdings card; loan → loan profile", () => {
    expect(marketWalletHref("0xbd94cade097e50ac")).toBe("/share/0xbd94cade097e50ac")
    expect(loanWalletHref("0xbd94cade097e50ac")).toBe("/analytics/wallets/0xbd94cade097e50ac")
  })
  it("both destinations are anon-public (a signed-out click never lands on /login)", () => {
    expect(isPublicPath(marketWalletHref("0xbd94cade097e50ac"), "GET")).toBe(true)
    expect(isPublicPath(loanWalletHref("0xbd94cade097e50ac"), "GET")).toBe(true)
  })
})

describe("call sites use the helper for their context", () => {
  const MARKET = [
    "app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx",
    "components/analytics/TopBuyers.tsx",
    "app/(collections)/[collection]/pack/dist/[distId]/page.tsx",
  ]
  it.each(MARKET)("%s links wallets with marketWalletHref", (rel) => {
    const src = read(rel)
    expect(src).toMatch(/marketWalletHref\(/)
    expect(src).not.toMatch(/["'`]\/analytics\/wallets\//)
  })
  it("the moment modal's 'Defaulted by' is a loan context", () => {
    const src = read("components/MomentDetailModal.tsx")
    expect(src).toMatch(/loanWalletHref\(moment\.sourceAddress\)/)
  })
})

// ── Tree walk: outside the analytics section, nothing reachable from a public page
// hard-codes a link into the loan profile — it goes through a helper. ──────────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?)$/.test(e)) out.push(p)
  }
  return out
}
const FILES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components")), ...walk(join(ROOT, "lib"))]
const SET = new Set(FILES)
function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith(".")) base = join(dirname(from), spec)
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (SET.has(c)) return c
  return null
}
const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
function importsOf(f: string): string[] {
  const out: string[] = []
  for (const m of readFileSync(f, "utf8").matchAll(IMPORT)) {
    const r = resolveImport(f, m[1] ?? m[2])
    if (r) out.push(r)
  }
  return out
}
// The analytics section's own pages and dashboards are loan / ecosystem contexts.
// Both read forward slashes on every OS — with "/" only, a Windows walk matched no entry and
// reached 0 files, so the guard went red on this box only (2026-10-26).
const INSIDE_ANALYTICS = (rel: string) => {
  const r = rel.split("\\").join("/")
  return r.startsWith("app/(analytics)/") || r.startsWith("app/admin/") || r.startsWith("app/api/")
}
const ENTRY = /[\\/](page|layout|template|not-found|error)\.tsx$/
const RAW = /["'`]\/analytics\/wallets\//

function reachableOutsideAnalytics(): Set<string> {
  const seen = new Set<string>()
  const queue = FILES.filter((f) => ENTRY.test(f) && f.startsWith(join(ROOT, "app")) && !INSIDE_ANALYTICS(relative(ROOT, f)))
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const i of importsOf(f)) if (!seen.has(i) && !INSIDE_ANALYTICS(relative(ROOT, i))) queue.push(i)
  }
  return seen
}

describe("tree walk: pages outside the analytics section link wallets through a helper", () => {
  const reach = reachableOutsideAnalytics()
  it("the walk reaches the public pages and the components they render", () => {
    expect(reach.size).toBeGreaterThan(300)
    for (const f of ["components/MomentDetailModal.tsx", "components/analytics/TopBuyers.tsx"]) {
      expect(reach.has(join(ROOT, f)), `${f} should be reachable`).toBe(true)
    }
  })
  it("catches a planted defect", () => {
    expect(RAW.test(stripComments('<a href={`/analytics/wallets/${a}`}>x</a>'))).toBe(true)
    expect(RAW.test(stripComments("// see /analytics/wallets/ for loans"))).toBe(false)
  })
  it("finds none", () => {
    const bad: string[] = []
    for (const f of reach) {
      const rel = relative(ROOT, f).split("\\").join("/")
      if (rel === "lib/analytics/wallet-href.ts") continue
      if (RAW.test(stripComments(readFileSync(f, "utf8")))) bad.push(rel)
    }
    expect(bad, "link wallets through marketWalletHref / loanWalletHref (lib/analytics/wallet-href.ts)").toEqual([])
  })
})
