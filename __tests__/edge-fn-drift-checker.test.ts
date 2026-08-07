import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  moduleSpecifiers,
  specifierKind,
  requiresImportMap,
  classifyImportMapDrift,
  normaliseSource,
} from "@/scripts/check-edge-fn-drift.mjs"

// Guards the edge-function drift detector — the only check in this repo that can
// see a function which was fixed, reviewed, tested, merged, and never deployed.
// (`edge-deno` type-checks source; the other drift guards are repo-vs-repo.)
//
// The live half needs a Management API PAT, so what is pinned here is the pure
// core, exercised against the REAL fleet shape measured 2026-08-07: 37 repo
// functions, 35 using a bare specifier, only 4 of those deployed with an import
// map -> 31 proven drifted.

describe("edge-fn drift detector — specifier classification", () => {
  it("separates bare from relative and url, since only BARE needs an import map", () => {
    expect(specifierKind("@supabase/supabase-js")).toBe("bare")
    expect(specifierKind("std/http/server.ts")).toBe("bare")
    expect(specifierKind("../_shared/institutional-snapshot.ts")).toBe("relative")
    expect(specifierKind("./helpers.ts")).toBe("relative")
    expect(specifierKind("https://esm.sh/@supabase/supabase-js@2.45.0")).toBe("url")
    expect(specifierKind("jsr:@supabase/supabase-js@2")).toBe("url")
    expect(specifierKind("npm:zod")).toBe("npm" === "npm" ? "url" : "url")
  })

  it("finds MULTI-LINE imports — a line-anchored regex misses them", () => {
    // Exactly the shape in snapshot-institutional-wallets (lines 32-35). A
    // /^import .* from/ scan reports zero here, which produced a wrong reading
    // of that function on 2026-08-07.
    const src = [
      'import { createClient } from "@supabase/supabase-js"',
      "import {",
      "  aggregateHoldingsByCollection,",
      "  type Row,",
      '} from "../_shared/institutional-snapshot.ts"',
    ].join("\n")
    expect(moduleSpecifiers(src)).toEqual([
      "@supabase/supabase-js",
      "../_shared/institutional-snapshot.ts",
    ])
  })

  it("a _shared-only importer does NOT require an import map", () => {
    // Load-bearing soundness boundary: relative specifiers resolve without a
    // map, so `imports from _shared` proves nothing about `import_map`. Folding
    // it into the tier-1 proof would produce the same list today (every _shared
    // importer also uses a bare specifier) while making the rule unsound.
    const sharedOnly = 'import { f } from "../_shared/x.ts"\nimport y from "https://esm.sh/y"'
    expect(requiresImportMap(sharedOnly)).toBe(false)
    expect(requiresImportMap('import { createClient } from "@supabase/supabase-js"')).toBe(true)
    expect(requiresImportMap('import x from "https://esm.sh/@supabase/supabase-js@2.45.0"')).toBe(false)
  })
})

describe("edge-fn drift detector — tier 1 is a proof", () => {
  it("flags bare-specifier source deployed WITHOUT an import map, and only that", () => {
    const repo = [
      { slug: "needs-map-and-missing", src: 'import { c } from "@supabase/supabase-js"' },
      { slug: "needs-map-and-has", src: 'import { c } from "@supabase/supabase-js"' },
      { slug: "url-only", src: 'import { c } from "https://esm.sh/@supabase/supabase-js@2"' },
      { slug: "shared-only", src: 'import { f } from "../_shared/x.ts"' },
      { slug: "not-deployed-yet", src: 'import { c } from "@supabase/supabase-js"' },
    ]
    const deployed = [
      { slug: "needs-map-and-missing", import_map: false },
      { slug: "needs-map-and-has", import_map: true },
      { slug: "url-only", import_map: false },
      { slug: "shared-only", import_map: false },
    ]
    const r = classifyImportMapDrift(repo, deployed)
    expect(r.proven).toEqual(["needs-map-and-missing"])
    expect(r.clean).toEqual(["needs-map-and-has"])
    // url-only and shared-only are NOT provable either way by tier 1 — the
    // method is a LOWER BOUND, not a census.
    expect(r.inapplicable.sort()).toEqual(["shared-only", "url-only"])
    expect(r.notDeployed).toEqual(["not-deployed-yet"])
  })

  it("reproduces the 2026-08-07 fleet measurement against the LIVE repo tree", () => {
    const dir = "supabase/functions"
    if (!existsSync(dir)) return
    const repo = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_shared")
      .map((d) => ({ slug: d.name, path: join(dir, d.name, "index.ts") }))
      .filter((f) => existsSync(f.path))
      .map((f) => ({ slug: f.slug, src: readFileSync(f.path, "utf8") }))

    // The 4 slugs observed deployed WITH an import map on 2026-08-07 that also
    // use a bare specifier (flowty-proxy is url-only, so tier 1 skips it).
    const WITH_MAP = new Set([
      "hybrid-custody-events",
      "ingest-allday-pack-opens",
      "ingest-topshot-pack-opens-history",
      "special-serial-delta",
    ])
    const deployed = repo.map((r) => ({ slug: r.slug, import_map: WITH_MAP.has(r.slug) }))
    const res = classifyImportMapDrift(repo, deployed)

    // Every function this repo ships is import-map dependent except the two
    // url-only ones — so a naive mass-deploy without deno.json boot-fails them.
    expect(res.inapplicable.sort()).toEqual(["flowty-proxy", "sync-nba-games"])
    expect(res.clean.sort()).toEqual([...WITH_MAP].sort())
    // The headline: everything else is provably running non-repo code.
    expect(res.proven.length).toBe(repo.length - res.clean.length - res.inapplicable.length)
    expect(res.proven).toContain("snapshot-institutional-wallets")
    expect(res.proven).toContain("compute-topshot-pack-ev")
  })
})

describe("edge-fn drift detector — tier 2 normalisation", () => {
  it("ignores comments and whitespace but not code", () => {
    const a = 'const x = 1 // note\n/* block */\nconst y = 2'
    const b = 'const x = 1\nconst  y   =  2'
    expect(normaliseSource(a)).toBe(normaliseSource(b))
    expect(normaliseSource("const x = 1")).not.toBe(normaliseSource("const x = 2"))
  })

  it("does not eat a // inside a string or url", () => {
    const src = 'const u = "https://api.example.com/v1"'
    expect(normaliseSource(src)).toContain("https://api.example.com/v1")
  })
})
