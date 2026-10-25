// @vitest-environment jsdom
//
// 2026-10-25 — a signed-out walk of production found public pages linking wallet
// names into /analytics/wallets/*, a SIGN-IN area: the click landed on /login.
// The 10-11 platform review (M7) already removed the signed-out nav link for the
// same reason ("a visible link that 307s on click — the same dead end one step
// later"); this pins the same rule for wallet links.
//
// 1. walletProfileHref: signed in → the analytics profile; otherwise → /share.
// 2. useIsSignedIn reads the session once and defaults to signed out.
// 3. TREE WALK over the import graph: no file reachable from a PUBLIC page may
//    hard-code an /analytics/wallets/ link — it must go through walletProfileHref.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname, relative } from "node:path"
import { renderHook, waitFor } from "@testing-library/react"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isPublicPath } from "@/proxy"

const session = vi.hoisted(() => ({ value: null as unknown, calls: 0 }))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getSession: () => {
        session.calls++
        return Promise.resolve({ data: { session: session.value } })
      },
    },
  }),
}))

import { walletProfileHref } from "@/lib/analytics/wallet-href"
import { useIsSignedIn, __resetIsSignedInCache } from "@/lib/hooks/useIsSignedIn"

describe("walletProfileHref", () => {
  it("signed in → the analytics wallet profile; signed out → the public wallet page", () => {
    expect(walletProfileHref("0xbd94cade097e50ac", true)).toBe("/analytics/wallets/0xbd94cade097e50ac")
    expect(walletProfileHref("0xbd94cade097e50ac", false)).toBe("/share/0xbd94cade097e50ac")
  })
  it("the two destinations are what the proxy says they are (the premise)", () => {
    expect(isPublicPath("/share/0xbd94cade097e50ac", "GET")).toBe(true)
    expect(isPublicPath("/analytics/wallets/0xbd94cade097e50ac", "GET")).toBe(false)
  })
})

describe("useIsSignedIn", () => {
  beforeEach(() => { __resetIsSignedInCache(); session.calls = 0 })
  it("is false with no session and true with one", async () => {
    session.value = null
    const a = renderHook(() => useIsSignedIn())
    await waitFor(() => expect(session.calls).toBe(1))
    expect(a.result.current).toBe(false)
    __resetIsSignedInCache()
    session.value = { user: { id: "u1" } }
    const b = renderHook(() => useIsSignedIn())
    await waitFor(() => expect(b.result.current).toBe(true))
  })
  it("reads the session once for every caller on the page", async () => {
    session.value = { user: { id: "u1" } }
    const hooks = [renderHook(() => useIsSignedIn()), renderHook(() => useIsSignedIn()), renderHook(() => useIsSignedIn())]
    await waitFor(() => hooks.forEach((h) => expect(h.result.current).toBe(true)))
    expect(session.calls).toBe(1)
  })
})

// ── Tree walk ────────────────────────────────────────────────────────────────
const ROOT = join(__dirname, "..")
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
  const src = readFileSync(f, "utf8")
  const out: string[] = []
  for (const m of src.matchAll(IMPORT)) {
    const r = resolveImport(f, m[1] ?? m[2])
    if (r) out.push(r)
  }
  return out
}
const SIGN_IN_ONLY = (rel: string) => rel.startsWith("app/(analytics)/") || rel.startsWith("app/admin/") || rel.startsWith("app/api/")
const ENTRY = /\/(page|layout|template|not-found|error)\.tsx$/
// A raw link INTO the sign-in-only wallet section.
const RAW = /["'`]\/analytics\/wallets\//

export function publicReachable(): Set<string> {
  const seen = new Set<string>()
  const queue = FILES.filter((f) => ENTRY.test(f) && f.startsWith(join(ROOT, "app")) && !SIGN_IN_ONLY(relative(ROOT, f)))
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const i of importsOf(f)) if (!seen.has(i) && !SIGN_IN_ONLY(relative(ROOT, i))) queue.push(i)
  }
  return seen
}

describe("tree walk: a public page never hard-codes a link into /analytics/wallets/", () => {
  it("the walk reaches the public pages and the components they render", () => {
    const reach = publicReachable()
    expect(reach.size).toBeGreaterThan(300)
    for (const f of ["components/MomentDetailModal.tsx", "components/analytics/TopBuyers.tsx", "app/(collections)/[collection]/analytics/CollectionAnalyticsClient.tsx"]) {
      expect(reach.has(join(ROOT, f)), `${f} should be reachable from a public page`).toBe(true)
    }
  })
  it("catches a planted defect", () => {
    expect(RAW.test(stripComments('<a href={`/analytics/wallets/${a}`}>x</a>'))).toBe(true)
    expect(RAW.test(stripComments("// see /analytics/wallets/ for loans"))).toBe(false)
  })
  it("finds none", () => {
    const bad: string[] = []
    for (const f of publicReachable()) {
      const rel = relative(ROOT, f)
      if (rel === "lib/analytics/wallet-href.ts") continue
      const src = stripComments(readFileSync(f, "utf8"))
      if (RAW.test(src)) bad.push(rel)
    }
    expect(bad, "link wallets through walletProfileHref (lib/analytics/wallet-href.ts)").toEqual([])
  })
})
