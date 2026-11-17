import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// /profile/[username] must NOT reach its data over HTTP.
//
// Until 2026-08-07 the SSR shell was `force-dynamic` and obtained its payload by
// fetching its OWN API route (`/api/public/profile/<username>`) with
// `cache: "no-store"`. Every request therefore cost TWO lambda invocations plus
// uncached DB work, on the heaviest uncached public route — 14,652 hits/12h
// during the 2026-08-06 crawl, which also accounted for most of the traffic
// attributed to the API route itself (the page was calling itself). It further
// meant the page could 500 purely because its own API had been rate limited —
// a self-inflicted dependency between a page and its own edge budget.
//
// The self-fetch's REASON was legitimate: one payload shape for page and
// client, zero divergence. That is now preserved by extraction —
// lib/profile/public-profile.ts, called by BOTH the page and the route — so the
// guarantee survives without the HTTP hop. The failure mode this guards is a
// well-meaning revert: someone "fixes" a shape bug by re-adding the fetch.
//
// This is a SOURCE pin, deliberately. The behaviour is an absence (no network
// call during SSR), and absence is far more robustly asserted by reading the
// file than by trying to prove a negative through a mocked-fetch render.
// ─────────────────────────────────────────────────────────────────────────────

// ⚠ 2026-08-13 — this guard's FILE SET was the hole in it.
//
// It enumerated `page.tsx` by hand, so when the same self-fetch survived in the
// SIBLING `layout.tsx` (which is the CRAWLER path — it builds the unfurl) the
// guard stayed green for six days while the anti-pattern it exists to forbid
// was still shipping on every social preview. Running it more often could never
// have found that; only widening the set could. Both server entry points for
// this route are now covered, and a third would need adding here too.
const ROOT = process.cwd()
const PAGE = path.join(ROOT, "app", "profile", "[username]", "page.tsx")
const LAYOUT = path.join(ROOT, "app", "profile", "[username]", "layout.tsx")
const ROUTE = path.join(ROOT, "app", "api", "public", "profile", "[username]", "route.ts")
const SHARED = path.join(ROOT, "lib", "profile", "public-profile.ts")

const read = (p: string) => fs.readFileSync(p, "utf8")

// Strip comments before asserting on CODE. The modules under test document the
// very identifiers these assertions forbid ("we intentionally DROP the RPC's
// acquired_price / acquisition_method", "strip wallet ADDRESSES"), so a naive
// source regex matches the prose explaining the invariant and reds while the
// code is correct — which is exactly what happened when this file was written.
// A guard that fires on its own documentation trains people to delete the
// documentation.
const codeOf = (p: string) =>
  stripComments(read(p))

describe("/profile/[username] SSR shell", () => {
  // Comments stripped throughout: this page's header documents the removed
  // self-fetch (and names the very path/env vars asserted against), so these
  // guards must read CODE or they fire on their own rationale.
  const src = codeOf(PAGE)

  it("does not call fetch() at all", () => {
    // Catches `fetch(`, `await fetch(`, `globalThis.fetch(` alike.
    expect(/\bfetch\s*\(/.test(src)).toBe(false)
  })

  it("does not reference its own API path", () => {
    expect(src).not.toMatch(/\/api\/public\/profile/)
  })

  it("does not rebuild an absolute site URL (the self-fetch's tell)", () => {
    // siteUrl()/NEXT_PUBLIC_SITE_URL/VERCEL_URL existed only to address itself.
    expect(src).not.toMatch(/VERCEL_URL|NEXT_PUBLIC_SITE_URL|rippackscity\.com/)
  })

  it("sources its data from the shared module", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/profile\/public-profile["']/)
    expect(src).toMatch(/getPublicProfile\s*\(/)
  })

  it("is no longer force-dynamic, so repeat crawls can be served from ISR", () => {
    expect(src).not.toMatch(/dynamic\s*=\s*["']force-dynamic["']/)
    expect(src).toMatch(/export\s+const\s+revalidate\s*=\s*\d+/)
  })

  it("keeps dynamicParams on so an unknown username still renders on demand", () => {
    expect(src).toMatch(/export\s+const\s+dynamicParams\s*=\s*true/)
  })
})

describe("/profile/[username] metadata shell", () => {
  // Same treatment as the page: comments stripped, because this file documents
  // the removed self-fetch and names the very identifiers asserted against.
  const src = codeOf(LAYOUT)

  it("does not call fetch() at all", () => {
    expect(/\bfetch\s*\(/.test(src)).toBe(false)
  })

  it("does not reference its own API path", () => {
    expect(src).not.toMatch(/\/api\/public\/profile/)
  })

  it("sources its data from the shared module", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/profile\/public-profile["']/)
    expect(src).toMatch(/getPublicProfile\s*\(/)
  })

  it("passes the same source label as the page, so both share one memoized read", () => {
    // The memo keys on arguments. A different label here is a silent cache
    // miss: correct output, double the DB work, every test still green.
    const pageSrc = codeOf(PAGE)
    const label = (s: string) => s.match(/getPublicProfile\(\s*[^,]+,\s*["']([^"']+)["']/)?.[1]
    expect(label(src)).toBeDefined()
    expect(label(src)).toBe(label(pageSrc))
  })
})

describe("shared payload contract — one query, two callers", () => {
  it("the shared module memoizes per request", () => {
    // Two server callers now run in the same render pass. Without this the
    // self-fetch removal is undone in cost terms — the hop is gone but the
    // query runs twice.
    const code = codeOf(SHARED)
    expect(code).toMatch(/cache\s*\(\s*getPublicProfileUncached\s*\)/)
    expect(code).toMatch(/from\s+["']react["']/)
  })


  it("the API route delegates rather than re-querying", () => {
    const src = read(ROUTE)
    expect(src).toMatch(/getPublicProfile\s*\(/)
    // The whole point is that the query lives in exactly one place. If these
    // reappear here, the shapes can drift again.
    expect(src).not.toMatch(/get_trophy_slab_data_by_username/)
    expect(src).not.toMatch(/from\(["']saved_wallets["']\)/)
  })

  it("the shared module still strips wallet addresses from the public payload", () => {
    // Privacy invariant: saved_wallets rows carry addresses; the public bundle
    // must never include one. Asserted on the selected column list, comments
    // stripped so the doc-comment describing this rule cannot satisfy it.
    const code = codeOf(SHARED)
    expect(code).toMatch(/from\(["']saved_wallets["']\)/)
    expect(code).not.toMatch(/wallet_address/)
  })

  it("the shared module does not leak owner cost basis into the public payload", () => {
    const code = codeOf(SHARED)
    expect(code).not.toMatch(/acquired_price/)
    expect(code).not.toMatch(/acquisition_method/)
  })
})
