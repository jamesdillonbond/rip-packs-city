import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ⛔ `lib/supabase.ts` builds the SERVICE-ROLE client at module load. In a browser
// SUPABASE_SERVICE_ROLE_KEY is undefined, supabase-js throws
// "supabaseKey is required." DURING MODULE EVALUATION, and the page falls to the
// global error boundary — no panel, no fallback, just "Something went wrong".
//
// 2026-09-28: TrophySlab ("use client") → lib/trophy/slab-href.ts →
// lib/panini/edition-market.ts → lib/supabase.ts. Every signed-in visit to
// rippackscity.com (/ → /dashboard) crashed; PaniniSniper had the same chain.
// tsc, vitest, lint and the build were all green — the failure exists only in a
// browser, so nothing but this walk can see it before a user does.
//
// Walks EVERY "use client" module in app/ and components/ (a tree walk, not a
// list) through its static and dynamic `@/` / relative imports.

const ROOT = process.cwd()
const TARGET = "lib/supabase.ts"

function walkDir(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walkDir(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null
  const base = spec.startsWith("@/") ? spec.slice(2) : join(dirname(from), spec)
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext
    if (existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile()) return p
  }
  return null
}

// `import type` / `export type` are erased at build and load nothing, so they
// are skipped (lib/marketplace-status.ts is reached only that way, harmlessly).
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm

function chainTo(root: string): string[] | null {
  const parent = new Map<string, string | null>([[root, null]])
  const queue = [root]
  while (queue.length) {
    const f = queue.shift()!
    if (f === TARGET) {
      const chain: string[] = []
      for (let c: string | null = f; c; c = parent.get(c) ?? null) chain.unshift(c)
      return chain
    }
    const src = readFileSync(join(ROOT, f), "utf8")
    for (const m of src.matchAll(IMPORT_RE)) {
      const r = resolve(f, m[1] ?? m[2] ?? m[3])
      if (r && !parent.has(r)) {
        parent.set(r, f)
        queue.push(r)
      }
    }
  }
  return null
}

// Leading comments are removed by the SHARED stripper (a local regex stripper is
// banned by guards-use-the-shared-comment-stripper); the directive must then be
// the first statement.
const isClient = (p: string) => /^\s*["']use client["']/.test(stripComments(readFileSync(join(ROOT, p), "utf8")))

describe("no client module can load lib/supabase.ts", () => {
  const clients = [...walkDir("app"), ...walkDir("components")].filter(isClient)

  it("inspects a real population of client modules", () => {
    // A walk that matches nothing passes vacuously — assert what it inspected.
    expect(clients.length).toBeGreaterThan(200)
    expect(clients).toContain("components/TrophySlab.tsx")
    expect(clients).toContain("components/collection/PaniniSniper.tsx")
  })

  it("the resolver finds the chain when one exists (positive control)", () => {
    expect(chainTo("lib/panini/edition-market.ts")).toEqual(["lib/panini/edition-market.ts", TARGET])
  })

  it("a type-only import does not count as a load (negative control)", () => {
    // useMarketplaceStatus reaches lib/marketplace-status.ts only via `import type`.
    expect(chainTo("components/marketplace-status/useMarketplaceStatus.ts")).toBeNull()
  })

  it("⛔ no \"use client\" module reaches it through any import chain", () => {
    const offenders = clients
      .map((c) => chainTo(c))
      .filter((c): c is string[] => c !== null)
      .map((c) => c.join(" -> "))
    expect(offenders).toEqual([])
  })
})
