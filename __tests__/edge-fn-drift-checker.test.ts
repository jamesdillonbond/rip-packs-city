import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  moduleSpecifiers,
  specifierKind,
  requiresImportMap,
  classifyImportMapDrift,
  normaliseSource,
  runContentCensus,
  matchDialects,
  driftExitCode,
  partitionByDeploySafety,
  GATE_KEY_DEPLOY_BLOCKED,
} from "@/scripts/check-edge-fn-drift.mjs"
import {
  pickEntrypoint,
  tightNormalise,
  bareSpecifiers,
  extractEntrypointSource,
  canonicaliseSource,
} from "@/scripts/lib/eszip-source.mjs"

// Guards the edge-function drift detector — the only check in this repo that can
// see a function which was fixed, reviewed, tested, merged, and never deployed.
// (`edge-deno` type-checks source; the other drift guards are repo-vs-repo.)
//
// The live half needs a Management API PAT, so what is pinned here is the pure
// core, exercised against the REAL fleet shape measured 2026-08-07: 37 repo
// functions, 35 using a bare specifier, only 4 of those deployed with an import
// map -> 31 proven drifted. Tree is 38 as of 2026-08-18 (resolve-allday-rip-dist-api
// gained a committed source); it is url-only, so the 35/4/31 figures are unchanged.

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

    // Every function this repo ships is import-map dependent except the three
    // url-only ones — so a naive mass-deploy without deno.json boot-fails them.
    //
    // resolve-allday-rip-dist-api joined this list on 2026-08-18, and it did NOT
    // change the headline: it is url-only (esm.sh), so tier 1 is INAPPLICABLE to it
    // and proven stays 31. Its arrival is a repo-tree change, not a drift finding —
    // the function was deployed all along with no committed source, which is a gap
    // this detector cannot see either (it compares repo-vs-deployed for slugs the
    // repo HAS). The count in this file's header comment moved 37 -> 38 for the
    // same reason.
    expect(res.inapplicable.sort()).toEqual([
      "flowty-proxy",
      "resolve-allday-rip-dist-api",
      "sync-nba-games",
    ])
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

// ── TIER 2: the census must never be confused with a census that did not run ──
//
// The loop used to swallow every body-read failure into a bare `catch {}` whose
// comment claimed "tier 1 still covers it". It does not: this detector's own
// header calls tier 1 a LOWER BOUND and tier 2 "the only census". So a run where
// every body fetch failed reported the same DRIFT count as a run where the census
// completed and found nothing new — indistinguishable in the output, on the one
// instrument that can see a function which was merged and never deployed.
//
// These pin the counters, not the wording, and in particular pin `ran` as the
// POSITIVE CONTROL: false means nothing was read and no result may be presented
// as a census.
describe("edge-fn drift detector — tier 2 content census", () => {
  const repo = [
    { slug: "a", src: "const x = 1" },
    { slug: "b", src: "const y = 2" },
  ]
  const deployed = [
    { slug: "a", version: 3, updated_at: "2026-08-01" },
    { slug: "b", version: 4, updated_at: "2026-08-02" },
  ]

  it("flags a body that differs from repo source", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) => (slug === "a" ? "const x = 999" : "const y = 2"),
    })
    expect(r.contentDrift.map((c) => c.slug)).toEqual(["a"])
    expect(r.bodiesRead).toBe(2)
    expect(r.bodiesFailed).toBe(0)
    expect(r.ran).toBe(true)
  })

  // ── ESZIP containment mode (2026-08-30) ──────────────────────────────────
  // The Management API serves /body as an eszip bundle since ~08-09; the census
  // read 0 bodies for 12 nightly runs. Containment: repo source found in the
  // bundle = clean; missing = eszipMisses (loud, but never counted as PROVEN).
  // Since parse mode landed (same day), containment is the FALLBACK — these
  // tests exercise it by not injecting `parseEszip`, which is exactly the
  // runtime condition that selects it.
  it("eszip: a bundle containing the repo source (any whitespace) reads clean", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) =>
        slug === "a"
          ? { eszip: "ESZIP2.3\x00\x01module: const  x =\n1 \x02tail" }
          : { eszip: "ESZIP2.3 const y = 2 " },
    })
    expect(r.bodiesRead).toBe(2)
    expect(r.contentDrift).toEqual([])
    expect(r.eszipMisses).toEqual([])
    expect(r.ran).toBe(true)
  })

  // Positive control (first live run, 2026-08-30 20:02Z): Supabase's bundler
  // transpiles sources, so on the real fleet containment matched 0 of 38 — a
  // census that matched NOTHING has measured nothing and must say so.
  it("eszip: when containment matches ZERO bundles, tier 2 reports did-not-run instead of 38 misses", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async () => ({ eszip: "ESZIP2.3 transpiled-beyond-recognition " }),
    })
    expect(r.ran).toBe(false)
    expect(r.bodiesRead).toBe(0)
    expect(r.bodiesFailed).toBe(2)
    expect(r.eszipMisses).toEqual([])
    expect(r.bodyFailures.some((f: string) => f.includes("matched 0 of 2"))).toBe(true)
  })

  it("eszip: a bundle NOT containing the repo source lands in eszipMisses, not contentDrift", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) =>
        slug === "a" ? { eszip: "ESZIP2.3 const x = 999 " } : { eszip: "ESZIP2.3 const y = 2 " },
    })
    expect(r.bodiesRead).toBe(2)
    expect(r.contentDrift).toEqual([])
    expect(r.eszipMisses.map((m: any) => m.slug)).toEqual(["a"])
    // Misses are UNPROVEN: the run still counts as having run, and the drift
    // exit code does not include them.
    expect(r.ran).toBe(true)
  })

  it("ignores comment and whitespace differences, so a reformat is not drift", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) => (slug === "a" ? "const  x = 1 // added later" : "/* hi */ const y = 2"),
    })
    expect(r.contentDrift).toEqual([])
    expect(r.ran).toBe(true)
  })

  // The whole point: a total failure must be DISTINGUISHABLE from a clean census.
  it("reports ran=false when every body read fails, instead of reading as clean", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async () => {
        throw new Error("HTTP 403")
      },
    })
    expect(r.ran).toBe(false)
    expect(r.bodiesRead).toBe(0)
    expect(r.bodiesFailed).toBe(2)
    // An empty contentDrift here means "did not look", NOT "found nothing" — and
    // the only thing separating those two is `ran`.
    expect(r.contentDrift).toEqual([])
    expect(r.bodyFailures.join(" ")).toContain("HTTP 403")
  })

  it("counts a partial failure and still censuses what it could read", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) => {
        if (slug === "a") throw new Error("HTTP 500")
        return "const y = 222"
      },
    })
    expect(r.ran).toBe(true)
    expect(r.bodiesRead).toBe(1)
    expect(r.bodiesFailed).toBe(1)
    expect(r.contentDrift.map((c) => c.slug)).toEqual(["b"])
  })

  // A 200 carrying no entrypoint is a failed read. Counting it as read is how an
  // API shape change silently turns the census into a permanent all-clear.
  it("treats a 200 with no index.ts as a FAILED read, not a clean one", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async () => ({ files: [{ name: "deno.json", content: "{}" }] }),
    })
    expect(r.bodiesRead).toBe(0)
    expect(r.bodiesFailed).toBe(2)
    expect(r.ran).toBe(false)
    expect(r.bodyFailures.join(" ")).toContain("no index.ts")
  })

  it("reads the entrypoint out of a files[] response shape", async () => {
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async () => ({ files: [{ name: "src/index.ts", content: "const x = 1" }] }),
    })
    expect(r.bodiesRead).toBe(2)
    // repo "b" is `const y = 2`, so serving `const x = 1` for it IS drift.
    expect(r.contentDrift.map((c) => c.slug)).toEqual(["b"])
  })

  it("skips the census when not attempted, and says so via ran=false", async () => {
    let called = 0
    const r = await runContentCensus({
      repo,
      deployed,
      attempted: false,
      fetchBody: async () => {
        called++
        return "x"
      },
    })
    expect(called).toBe(0)
    expect(r.ran).toBe(false)
    expect(r.bodiesRead).toBe(0)
  })

  it("does not census a repo function that is not deployed", async () => {
    const r = await runContentCensus({
      repo: [...repo, { slug: "ghost", src: "const z = 3" }],
      deployed,
      fetchBody: async () => "const x = 1",
    })
    expect(r.bodiesRead).toBe(2)
    expect(r.bodyFailures).toEqual([])
  })

  // Failure messages go to a CI log and a deployed function can carry a gate key.
  it("keeps only failure MESSAGES, never body content, and caps how many it keeps", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ slug: `f${i}`, src: "const x = 1" }))
    const r = await runContentCensus({
      repo: many,
      deployed: many.map((m) => ({ slug: m.slug, version: 1, updated_at: "2026-08-01" })),
      fetchBody: async () => {
        throw new Error("HTTP 403")
      },
    })
    expect(r.bodiesFailed).toBe(9)
    expect(r.bodyFailures.length).toBe(5)
  })
})

// ── TIER 2 PARSE MODE — the real census over eszip bundles ───────────────────
//
// Containment's own positive control proved it can never census this fleet
// (matched 0 of 38 live: the hosted bundler transpiles before storing). Parse
// mode reads the bundle with @deno/eszip and compares module SOURCE across
// dialects; its calibration rule is the same philosophy one level up — a
// mismatch is only a finding once at least one function matched, because a
// comparison that matches NOTHING has more likely broken itself than found 38
// simultaneous drifts.
describe("edge-fn drift detector — tier 2 eszip parse mode", () => {
  const repo = [
    { slug: "a", src: "const x: number = 1\nconsole.log(x)\n" },
    { slug: "b", src: "const y = 2\nconsole.log(y)\n" },
  ]
  const deployed = [
    { slug: "a", version: 3, updated_at: "2026-08-01", entrypoint_path: "/tmp/f_a/source/index.ts" },
    { slug: "b", version: 4, updated_at: "2026-08-02", entrypoint_path: "/tmp/f_b/source/index.ts" },
  ]
  const eszipBody = async () => ({ eszip: "ESZIP2.3 ...bundle...", bytes: new Uint8Array([1, 2, 3]) })
  // The hosted bundler's dialect: types stripped, semicolons added — what a
  // real production bundle stores for these sources.
  const transpiled: Record<string, string> = {
    "/tmp/f_a/source/index.ts": "const x = 1;\nconsole.log(x);\n",
    "/tmp/f_b/source/index.ts": "const y = 2;\nconsole.log(y);\n",
  }
  const fakeParse = async (_bytes: Uint8Array, { entrypointPath }: any) => ({ source: transpiled[entrypointPath] })
  const fakeCanonicalise = async (src: string) => src.replace(": number", "")

  it("calibrated fleet: matches are clean, a real mismatch IS content drift", async () => {
    const parse = async (_b: Uint8Array, { entrypointPath }: any) =>
      entrypointPath.includes("f_a")
        ? { source: transpiled["/tmp/f_a/source/index.ts"] }
        : { source: "const y = 999;\nconsole.log(y);\n" } // deployed b differs for real
    const r = await runContentCensus({
      repo, deployed, fetchBody: eszipBody, parseEszip: parse, canonicalise: fakeCanonicalise,
    })
    expect(r.bodiesRead).toBe(2)
    expect(r.eszipParsed).toBe(2)
    expect(r.contentDrift.map((c: any) => c.slug)).toEqual(["b"])
    expect(r.ran).toBe(true)
    // and the match landed on a named dialect bridge, so the series can see it
    const matched = Object.values(r.parseMatchModes as Record<string, number>).reduce((s, n) => s + n, 0)
    expect(matched).toBe(1)
  })

  it("both matching across the dialect gap: clean census, no drift, modes counted", async () => {
    const r = await runContentCensus({
      repo, deployed, fetchBody: eszipBody, parseEszip: fakeParse, canonicalise: fakeCanonicalise,
    })
    expect(r.contentDrift).toEqual([])
    expect(r.bodiesRead).toBe(2)
    expect(r.ran).toBe(true)
  })

  // The calibration rule — parse mode's own version of containment's positive
  // control. Zero matches across the whole fleet means the DIALECT BRIDGE is
  // broken, not that everything drifted at once.
  it("UNCALIBRATED (zero matches anywhere): reports did-not-run, never 2 findings", async () => {
    const parse = async () => ({ source: "something the comparison cannot bridge at all" })
    const r = await runContentCensus({
      repo, deployed, fetchBody: eszipBody, parseEszip: parse, canonicalise: fakeCanonicalise,
    })
    expect(r.ran).toBe(false)
    expect(r.bodiesRead).toBe(0)
    expect(r.bodiesFailed).toBe(2)
    expect(r.contentDrift).toEqual([])
    expect(r.bodyFailures.some((f: string) => f.includes("matched 0 of 2"))).toBe(true)
  })

  it("a bundle the parser rejects is a FAILED read, not a clean one", async () => {
    const parse = async (_b: Uint8Array, { entrypointPath }: any) => {
      if (entrypointPath.includes("f_a")) throw new Error("wasm panic: not implemented")
      return { source: transpiled["/tmp/f_b/source/index.ts"] }
    }
    const r = await runContentCensus({
      repo, deployed, fetchBody: eszipBody, parseEszip: parse, canonicalise: fakeCanonicalise,
    })
    expect(r.bodiesFailed).toBe(1)
    expect(r.bodiesRead).toBe(1)
    expect(r.bodyFailures.join(" ")).toContain("eszip parse failed")
    expect(r.ran).toBe(true)
  })

  it("falls back to containment when the body carries no bytes, even with a parser present", async () => {
    // Same runtime condition as an old-shape cached body: {eszip} text only.
    const r = await runContentCensus({
      repo,
      deployed,
      fetchBody: async (slug: string) =>
        slug === "a"
          ? { eszip: "ESZIP2.3 const x: number = 1 console.log(x) " }
          : { eszip: "ESZIP2.3 const y = 2 console.log(y) " },
      parseEszip: fakeParse,
      canonicalise: fakeCanonicalise,
    })
    expect(r.eszipParsed).toBe(0)
    expect(r.bodiesRead).toBe(2)
    expect(r.contentDrift).toEqual([])
  })
})

describe("edge-fn drift detector — dialect bridges (matchDialects / tightNormalise)", () => {
  it("orders the ladder: verbatim, then comment/whitespace, then canonical", async () => {
    expect(await matchDialects("const a = 1", "const a = 1")).toBe("verbatim")
    expect(await matchDialects("const a = 1 // x", "/* y */ const  a = 1")).toBe("normalised")
    expect(await matchDialects("const a: number = 1", "const a = 1", async (s: string) => s.replace(": number", ""))).toBe("canonical")
    expect(await matchDialects("const a = 1", "const a = 2")).toBe(null)
  })

  it("canonical_tight bridges swc reprint artifacts: added semicolons, retabbed objects", async () => {
    const repoSide = 'fetch(url, { method: "POST", headers: h })\n'
    const deployedSide = 'fetch(url, {\n  method: "POST",\n  headers: h\n});\n'
    expect(await matchDialects(repoSide, deployedSide, async (s: string) => s)).toBe("canonical_tight")
  })

  it("a canonicalise failure degrades to the plain modes instead of throwing", async () => {
    const boom = async () => { throw new Error("swc choked") }
    expect(await matchDialects("const a = 1", "const  a = 1", boom)).toBe("normalised")
    expect(await matchDialects("const a: number = 1", "const a = 1;", boom)).toBe(null)
  })

  it("tightNormalise converts semicolons to SPACES before tightening — deletion would glue `1;console` ≠ `1 console`", () => {
    expect(tightNormalise("const x = 1;\nconsole.log(x);")).toBe(tightNormalise("const x = 1\nconsole.log(x)"))
    // and it must never bridge an actual code change
    expect(tightNormalise("const x = 1")).not.toBe(tightNormalise("const x = 2"))
  })
})

describe("edge-fn drift detector — eszip entrypoint identification", () => {
  const specs = [
    "file:///tmp/user_fn_p_abc_1/source/import_map.json",
    "file:///tmp/user_fn_p_abc_1/source/index.ts",
    "file:///tmp/user_fn_p_abc_1/source/_shared/util.ts",
    "https://esm.sh/@supabase/supabase-js@2",
  ]
  it("prefers the metadata entrypoint_path when it resolves", () => {
    expect(pickEntrypoint(specs, "/tmp/user_fn_p_abc_1/source/index.ts")).toBe("file:///tmp/user_fn_p_abc_1/source/index.ts")
  })
  it("falls back to the /source/index.ts shape, excluding _shared and remote modules", () => {
    expect(pickEntrypoint(specs)).toBe("file:///tmp/user_fn_p_abc_1/source/index.ts")
  })
  it("returns null when genuinely ambiguous — a failed read, never a guess", () => {
    expect(
      pickEntrypoint(["file:///a/source/index.ts", "file:///b/source/index.ts"])
    ).toBe(null)
  })

  // The LIVE bundle shape, measured 2026-08-30 on all 38 production bundles:
  // the function's own modules are RELATIVE specifiers, every dependency is an
  // absolute URL, and file:// never appears. The first picker looked only for
  // file:// and identified 0 of 38 entrypoints.
  it("identifies the relative-specifier entrypoint of a real production bundle", () => {
    const production = [
      "source/index.ts",
      "source/_shared/institutional-snapshot.ts",
      "https://jsr.io/@supabase/supabase-js/2.112.2/src/index.ts",
      "https://jsr.io/@supabase/functions-js/2.110.0/src/edge-runtime.d.ts",
      "https://esm.sh/some-dep@1.0.0",
    ]
    expect(pickEntrypoint(production, "/tmp/user_fn_ref_abc_6/source/index.ts")).toBe("source/index.ts")
    // and without the metadata hint, the source/index.ts shape still wins
    expect(pickEntrypoint(production)).toBe("source/index.ts")
  })
})

// The real thing, wasm and all: a production-shaped bundle built with the same
// library the census parses with. Proves the full extract → canonicalise →
// compare pipeline bridges the transpile gap on identical sources and still
// sees a one-token content change. (~100ms; if @deno/eszip ever breaks under
// Node this is the test that says so before a nightly run does.)
describe("edge-fn drift detector — eszip wasm integration", () => {
  const SRC = [
    'import { createClient } from "@supabase/supabase-js"',
    "// hourly sweep",
    "interface Row { id: number }",
    'const c = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("KEY")!)',
    "Deno.serve(async () => {",
    "  const r: Row = { id: 1 }",
    '  return new Response(JSON.stringify({ r, c: !!c }), { headers: { "Content-Type": "application/json" } })',
    "})",
    "",
  ].join("\n")

  async function buildProductionLikeBundle(src: string) {
    const { build } = await import("@deno/eszip")
    const spec = "file:///tmp/user_fn_proj_abc_1/source/index.ts"
    const mapUrl = "file:///tmp/user_fn_proj_abc_1/source/deno.json"
    return build(
      [spec],
      async (s: string) => {
        if (s === spec) return { kind: "module", specifier: s, content: src }
        if (s === mapUrl)
          return {
            kind: "module",
            specifier: s,
            content: JSON.stringify({ imports: { "@supabase/supabase-js": "https://esm.sh/@supabase/supabase-js@2" } }),
          }
        return { kind: "external", specifier: s }
      },
      mapUrl
    )
  }

  it("identical source bridges the transpile gap; a changed token does not", async () => {
    const bytes = await buildProductionLikeBundle(SRC)
    const ext = await extractEntrypointSource(bytes, { entrypointPath: "/tmp/user_fn_proj_abc_1/source/index.ts" })
    expect(ext.specifier).toBe("file:///tmp/user_fn_proj_abc_1/source/index.ts")
    // the stored source is TRANSPILED — this is the fact containment died on
    expect(ext.source).not.toContain("interface Row")
    expect(await matchDialects(SRC, ext.source, canonicaliseSource)).not.toBe(null)
    expect(await matchDialects(SRC.replace("id: 1", "id: 2"), ext.source, canonicaliseSource)).toBe(null)
  })

  it("bareSpecifiers finds from-imports and side-effect imports, skipping url/relative", () => {
    const src = 'import "polyfill-lib"\nimport { a } from "@x/y"\nimport b from "./local.ts"\nimport c from "https://esm.sh/z"'
    expect(bareSpecifiers(src).sort()).toEqual(["@x/y", "polyfill-lib"])
  })
})

describe("edge-fn drift detector — the run's exit code", () => {
  // Extracted from main() on 2026-08-29 because it DISAGREED with the report
  // printed immediately above it. The report already refuses to publish an
  // all-clear it did not earn ("no PROVEN drift — but the content census did not
  // run, so this is NOT an all-clear"); the exit code returned 0 anyway, and CI
  // reads the exit code, not the prose.

  it("fails when the content census could not run, even with ZERO proven drift", () => {
    // THE LATENT TRAP, and the reason this is worth a test rather than a comment.
    // Today tier 1 proves 19 drifted so the run is red for another reason and the
    // disagreement is invisible. Redeploy those 19 with their import maps and
    // driftedCount goes to 0 while tier 2 has still failed on all 38 bodies since
    // 2026-08-09 — the badge would go green and the natural reading is "fixed".
    expect(driftExitCode({ driftedCount: 0, tier2Attempted: true, tier2Ran: false })).toBe(1)
  })

  it("still fails on proven drift while the census is dead — today's actual state", () => {
    expect(driftExitCode({ driftedCount: 19, tier2Attempted: true, tier2Ran: false })).toBe(1)
  })

  it("passes ONLY when the census ran and found nothing", () => {
    // The positive control. Without this, a body that returns 1 unconditionally
    // would satisfy every other case in this block.
    expect(driftExitCode({ driftedCount: 0, tier2Attempted: true, tier2Ran: true })).toBe(0)
    expect(driftExitCode({ driftedCount: 1, tier2Attempted: true, tier2Ran: true })).toBe(1)
  })

  it("does not red on --tier1, where the census was never attempted", () => {
    // A guard that fails on its own documented opt-out is a guard people delete.
    // `tier2Ran` is false here for a categorically different reason: not asked,
    // rather than asked and unable.
    expect(driftExitCode({ driftedCount: 0, tier2Attempted: false, tier2Ran: false })).toBe(0)
    expect(driftExitCode({ driftedCount: 2, tier2Attempted: false, tier2Ran: false })).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The report must not tell you to cause an outage.
//
// 🚨 WHY. Tier 1 flags 19 functions as PROVEN drifted, and the report used to end
// with "Redeploy each ...". But six functions read Deno.env.get("<NAME>_GATE_KEY")
// while the secret is UNSET: deploying one makes its gate fail CLOSED and 403 on
// every tick — the mechanism of the 24h 2026-08-11 AllDay/Pinnacle outage.
//
// ⭐ And they are drifted BECAUSE they were never redeployed, which is the correct
// state: their signature (deployed import_map:false vs a bare-specifier repo
// source) is exactly what tier 1 keys on. So they appear in this report every
// night, forever, and the advice line pointed straight at them.
//
// ⚠ The list is a DATED SAMPLE and a KNOWN MINIMUM, so these tests pin the
// PARTITIONING BEHAVIOUR (and that the two known-drifted blocked ones are in it),
// never the exact size of the set — a guard that dies on a legitimate edit is a
// guard that gets deleted.
// ─────────────────────────────────────────────────────────────────────────────
describe("edge-fn drift: redeploy advice must exclude the gate-key-blocked functions", () => {
  it("separates the blocked ones from the safe ones", () => {
    const { safe, mustNotDeploy } = partitionByDeploySafety([
      "compute-topshot-pack-ev",
      "ingest-pinnacle-mints",
      "sales-serial-backfill",
      "compute-golazos-pack-ev",
    ])
    expect(mustNotDeploy).toEqual(["ingest-pinnacle-mints", "compute-golazos-pack-ev"])
    expect(safe).toEqual(["compute-topshot-pack-ev", "sales-serial-backfill"])
  })

  it("contains the two blocked functions that are ACTUALLY in the live drift list", () => {
    // Measured 2026-08-30: both appear among tier 1's 19 proven-drifted, so this
    // is not a hypothetical overlap — it is the live collision.
    expect(GATE_KEY_DEPLOY_BLOCKED.has("ingest-pinnacle-mints")).toBe(true)
    expect(GATE_KEY_DEPLOY_BLOCKED.has("compute-golazos-pack-ev")).toBe(true)
  })

  it("does NOT block the two functions deployed after the dual-accept cutoff", () => {
    // Over-blocking is a real cost too: it would leave a genuinely fixable
    // function stuck as permanent drift. Both were deployed 2026-08-15, so they
    // carry the _OLD fallback and are safe.
    expect(GATE_KEY_DEPLOY_BLOCKED.has("compute-pinnacle-pack-ev")).toBe(false)
    expect(GATE_KEY_DEPLOY_BLOCKED.has("backfill-topshot-pack-supply")).toBe(false)
  })

  it("treats an unknown slug as safe, so the list can never silently gate new work", () => {
    const { safe, mustNotDeploy } = partitionByDeploySafety(["some-brand-new-fn"])
    expect(safe).toEqual(["some-brand-new-fn"])
    expect(mustNotDeploy).toEqual([])
  })

  it("is order-preserving and total — every input lands in exactly one bucket", () => {
    const input = ["a", "ingest-pinnacle-mints", "b", "backfill-pack-opens-api", "c"]
    const { safe, mustNotDeploy } = partitionByDeploySafety(input)
    expect([...safe, ...mustNotDeploy].sort()).toEqual([...input].sort())
    expect(safe).toEqual(["a", "b", "c"])
  })
})
