import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { extractRouteWall, wallFraction, CENSORED_AT, MAP_IS_WRONG_ABOVE } from "@/lib/pipeline/route-walls"

// ─────────────────────────────────────────────────────────────────────────────
// THE MISSING HALF OF THE KILL INSTRUMENT.
//
// `lib/pipeline/kill-rate.ts` scores a tick `killed` when no terminal row
// correlates to its marker — right for the common case, with a MEASURED blind
// spot: on 2026-09-03 a tick of `cron/evm-transfers-ingest` carried a Vercel
// `Task timed out after 60 seconds` AND a marker AND a terminal row with
// `ok = true` and `duration_ms = 60,464` against a 60,000 ms wall. The terminal
// write raced the wall and won, so the correlation scored it healthy.
//
// The discriminator was always in the row — `duration_ms` against the ROUTE'S
// OWN wall — and the blocker was that no per-route wall existed in code. These
// cases pin the mapping that unblocks it.
//
// ⛔ AND THEY PIN THE REFUTED SHORTCUT AS REFUTED. Guessing walls from a set of
// round values (30/60/120/300/800 s) was tried and is wrong three times out of
// three: `wallet-backfill-multicollection` matched 120 s against a real 800,
// `wallet-backfill-golazos` 30 s against 60, `fmv-recalc` 60 s against 300. The
// clustering above a round number is each route's INTERNAL budget working — the
// opposite of a kill. Those three walls are asserted below so the shortcut
// cannot be reintroduced on a whim.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const API = path.join(ROOT, "app", "api")

function routes(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) routes(full, out)
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full)
  }
  return out
}

const WALLS = routes().map((full) =>
  extractRouteWall(
    path.relative(ROOT, full).split(path.sep).join("/"),
    stripComments(readFileSync(full, "utf8")),
  ),
)

const byRel = new Map(WALLS.map((w) => [w.rel, w]))

describe("every API route can be asked for its own ceiling", () => {
  it("is not vacuous — the walk found routes, walls and pipeline names", () => {
    expect(WALLS.length, "the app/api walk found no routes").toBeGreaterThan(200)
    expect(
      WALLS.filter((w) => w.maxDurationSec != null).length,
      "no route declared a maxDuration — the pattern probably stopped matching",
    ).toBeGreaterThan(50)
    expect(
      WALLS.filter((w) => w.pipelines.length > 0).length,
      "no route yielded a pipeline name — all three extraction shapes failed",
    ).toBeGreaterThan(30)
  })

  it("⛔ the three routes that refuted the round-number shortcut still carry those walls", () => {
    // Not a style pin: these are the counter-examples. If one of them changes,
    // the refutation in lib/pipeline/route-walls.ts needs re-deriving before
    // anyone leans on it again.
    expect(byRel.get("app/api/wallet-backfill-multicollection/route.ts")?.maxDurationSec).toBe(800)
    expect(byRel.get("app/api/wallet-backfill-golazos/route.ts")?.maxDurationSec).toBe(600)
    expect(byRel.get("app/api/fmv-recalc/route.ts")?.maxDurationSec).toBe(300)
  })

  it("extracts a pipeline name from each of the three shapes actually in use", () => {
    // `const PIPELINE = "…"`, a CONFIG object's `pipelineName:`, and the RPC's
    // own `p_pipeline:`. All three exist in the tree; a regex that quietly
    // stopped matching one would shrink the map without failing anything.
    expect(byRel.get("app/api/cron/evm-transfers-ingest/route.ts")?.pipelines).toContain(
      "evm-transfers-ingest",
    )
    expect(byRel.get("app/api/wallet-backfill-golazos/route.ts")?.pipelines).toContain(
      "wallet-backfill-golazos",
    )
    expect(byRel.get("app/api/cron/panini-ingest/route.ts")?.pipelines).toEqual(
      expect.arrayContaining(["panini-ingest", "panini-ingest-enum"]),
    )
  })

  it("an UNMAPPABLE route is returned as unmapped, never dropped", () => {
    // ⚠ The rule this repo states for paged reads applies to maps too: a partial
    // result that cannot be distinguished from a complete one is the defect. A
    // route with no extractable name must come back with `pipelines: []`.
    const nameless = extractRouteWall("x/route.ts", "export const maxDuration = 42\nconst P = someVar")
    expect(nameless.pipelines).toEqual([])
    expect(nameless.maxDurationSec).toBe(42)
    // And it is still IN the population, which is the half that matters.
    expect(WALLS.every((w) => Array.isArray(w.pipelines))).toBe(true)
  })

  it("⚠ prose cannot invent a pipeline — comments are the caller's job to strip", () => {
    // Every extraction pattern here matches a comment as readily as code, and
    // this repo's route headers quote pipeline names constantly. The module
    // documents that its input must be stripped; this case shows what happens
    // when it is not, so the requirement is not merely asserted in a comment.
    const withProse = '// const PIPELINE = "ghost-pipeline"\nexport const maxDuration = 9'
    expect(extractRouteWall("x/route.ts", withProse).pipelines).toContain("ghost-pipeline")
    expect(extractRouteWall("x/route.ts", stripComments(withProse)).pipelines).toEqual([])
  })
})

describe("wallFraction refuses to invent a measurement", () => {
  it("returns null for an unknown wall rather than 0 or 1", () => {
    // ⚠ THE `?? 0` SHAPE, in an instrument. A number here would let a caller
    // sort an unmeasured route among measured ones and read the result as a
    // ranking. Null is the only honest answer.
    expect(wallFraction(1000, null)).toBeNull()
    expect(wallFraction(null, 60)).toBeNull()
    expect(wallFraction(1000, 0)).toBeNull()
  })

  it("reads the golazos censored maximum at 0.997 of its OLD wall", () => {
    // The measurement the constant is set from: max 59,801 ms over 1,621 runs
    // against the 60,000 ms wall in place until 2026-09-03, while Vercel
    // independently logged 6 `Task timed out` on that route in 24 h.
    const f = wallFraction(59_801, 60)!
    expect(f).toBeGreaterThan(CENSORED_AT)
    expect(f).toBeCloseTo(0.997, 3)
    // ⭐ AND THE SAME RUN AGAINST THE NEW WALL IS UNREMARKABLE — which is the
    // whole point of raising it, and a control that the fraction tracks the
    // ROUTE rather than the duration.
    expect(wallFraction(59_801, 600)!).toBeLessThan(0.11)
  })

  it("🚨 a fraction FAR above 1 is the map failing, not the route dying", () => {
    // A route cannot record a run much longer than its own wall — the platform
    // terminates it. So a large fraction says the mapped route is not what
    // writes those rows. Confirmed on the first fleet sweep rather than assumed:
    // `refresh-pack-grail-metrics-mv` reads 163,382 ms against the route's 60 s
    // wall (2.7×) because migration 20260829235752 MOVED that refresh to pg_cron
    // — the Vercel route stopped being its ceiling on 2026-08-29.
    expect(wallFraction(163_382, 60)!).toBeGreaterThan(MAP_IS_WRONG_ABOVE)
    expect(wallFraction(1_303_432, 60)!).toBeGreaterThan(MAP_IS_WRONG_ABOVE)
    // ⚠ And the band that is NOT the map failing: just above 1, where a terminal
    // write raced the wall and won. `evm-transfers-ingest` 60,464 ms of 60,000,
    // with Vercel independently logging `Task timed out` on that invocation.
    expect(wallFraction(60_464, 60)!).toBeLessThan(MAP_IS_WRONG_ABOVE)
    expect(wallFraction(317_457, 300)!).toBeLessThan(MAP_IS_WRONG_ABOVE)
  })

  it("a duration past the wall reads above 1 rather than clamping", () => {
    // The evm-transfers-ingest case: 60,464 ms recorded against a 60,000 ms
    // wall. Clamping would erase exactly the signal — a row written at or past
    // the ceiling is the one worth looking at.
    expect(wallFraction(60_464, 60)!).toBeGreaterThan(1)
  })
})
