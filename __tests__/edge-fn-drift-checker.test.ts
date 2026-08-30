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
  driftExitCode,
  partitionByDeploySafety,
  GATE_KEY_DEPLOY_BLOCKED,
} from "@/scripts/check-edge-fn-drift.mjs"

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
