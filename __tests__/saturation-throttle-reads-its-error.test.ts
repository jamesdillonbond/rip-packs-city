import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// BAN (population ZERO): every cron route with a saturation self-throttle must
// READ the throttle count's error, not just its value.
//
// ── THE DEFECT THIS FREEZES ─────────────────────────────────────────────────
// Nine routes open with the same guard: count other pipelines' recent failures
// and skip this tick if the platform looks saturated. Each wrapped that read in a
// try/catch that FAILS CLOSED (`skipped: "throttle_error"`, tick abandoned) — and
// each then evaluated `if ((count ?? 0) > SATURATION_FAIL_THRESHOLD)`, which FAILS
// OPEN. Both branches sat in the same block:
//
//   promise REJECTS                    -> catch -> tick abandoned      (correct)
//   supabase-js returns {count:null,error} -> `?? 0` -> tick PROCEEDS  (fails open)
//
// supabase-js RETURNS errors rather than throwing, so the branch that fires in
// production was the one that failed open. The author's intent is unambiguous from
// the catch; only the shape they did not anticipate slipped through.
//
// ⚠ WHY IT MATTERS MORE THAN A NORMAL FAIL-OPEN: the throttle read is a
// `count: exact` over `pipeline_runs` — the table every pipeline is writing to —
// on a 2 GB IO-throttled instance. It is likeliest to fail during exactly the
// saturation it exists to detect, and a failed-open tick is indistinguishable from
// a healthy one in `pipeline_runs`, so nothing measured how often it happened.
//
// ── WHY A SOURCE GUARD ──────────────────────────────────────────────────────
// The runtime property is proven behaviourally in
// `__tests__/saturation-throttle-fails-closed.test.ts` on a representative route.
// This file exists for COMPLETENESS: nine near-identical copies is how the class
// arose, and a tenth route pasted from a sibling is how it would return. A guard
// that walks the tree cannot miss the tenth; nine hand-written behavioural tests
// can (and one of them already would have — see the PIPELINE note below).
//
// ⚠ A scripted sweep of the first eight SILENTLY SKIPPED the ninth, because
// `ufc-studio-sales-history-backfill` names its constant `PIPELINE` where the rest
// use `PIPELINE_NAME`. The per-file occurrence assert caught it. That is the whole
// argument for this guard being a directory walk rather than a list.

const CRON_DIR = join(process.cwd(), "app", "api", "cron")
const LIB_DIR = join(process.cwd(), "lib")

// 🚨 WIDENED 2026-08-23, AND THE WIDENING FOUND A LIVE TENTH COPY.
//
// This guard walked `app/api/cron` ONLY. Its own header above argues that "a
// guard that walks the tree cannot miss the tenth" — but it walked one
// DIRECTORY, not the tree, and the tenth copy was one directory over in
// `lib/studio-sales-history.ts`, which `golazos-studio-` and
// `allday-studio-sales-history-backfill` delegate to ENTIRELY. Those two routes
// carry no inline throttle, so they never appeared in this file's population and
// their breaker was the broken one — outside the ban BY CONSTRUCTION.
//
// ⚠ That is this repo's most-repeated guard defect: a guard's declared scope is
// itself a CLAIM, and coverage is only real against what the guard READS. The
// sibling case is the anon driver-message guard, which derived its file set from
// `isPublicPath` and so could not see anything behind sign-in.
//
// ⚠ The fix is not "add lib/studio-sales-history.ts" — a named file is the
// curated list this file already argues against. It is to walk a SECOND ROOT and
// let membership stay derived from carrying `SATURATION_FAIL_THRESHOLD`.

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) routeFiles(full, out)
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full)
  }
  return out
}

/** Blank out comments, preserving offsets. This file's own subject is quoted in
 *  prose in all nine routes, so a raw grep would pass on documentation alone. */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

/** Every `.ts` under a root — the cron walk is route-files-only, lib is not. */
function libFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) libFiles(full, out)
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full)
  }
  return out
}

function throttledRoutes(): { file: string; src: string }[] {
  return [...routeFiles(CRON_DIR), ...libFiles(LIB_DIR)]
    .map((f) => ({ file: relative(process.cwd(), f).split(sep).join("/"), src: stripComments(readFileSync(f, "utf8")) }))
    .filter((r) => r.src.includes("SATURATION_FAIL_THRESHOLD"))
    .sort((a, b) => a.file.localeCompare(b.file))
}

describe("saturation self-throttle reads its own error", () => {
  it("the walk finds the throttled routes (not vacuously passing)", () => {
    // ⚠ Asserts the WALK, and that the population is discoverable — never that it
    // is a particular SIZE. A count assertion would red the day a route is
    // retired, punishing exactly the cleanup this repo keeps doing (the
    // `topshot-flowty-unmapped-drain` schedule was retired mid-sweep).
    expect(routeFiles(CRON_DIR).length, "must find cron route files at all").toBeGreaterThan(20)
    expect(libFiles(LIB_DIR).length, "must find lib modules at all — the second root").toBeGreaterThan(50)
    expect(throttledRoutes().length, "must find routes carrying the throttle").toBeGreaterThan(0)
    // ⚠ THE SECOND ROOT MUST CONTRIBUTE. Adding a root that matches nothing is a
    // widening in name only, and it is what this guard just spent a live defect
    // learning. If the shared implementation moves again, this fails LOUDLY
    // rather than silently narrowing back to one directory.
    expect(
      throttledRoutes().filter((r) => r.file.startsWith("lib/")).length,
      "no lib/ module carries the throttle — the second root is contributing nothing; has the shared implementation moved?",
    ).toBeGreaterThan(0)
  })

  it("every throttled route destructures the count error", () => {
    const missing = throttledRoutes().filter((r) => !/const\s*\{\s*count\s*,\s*error:/.test(r.src))
    expect(
      missing.map((r) => r.file),
      "A saturation throttle that ignores its count's error FAILS OPEN: supabase-js\n" +
        "returns `{ count: null, error }` rather than throwing, so `count ?? 0` reads as\n" +
        "'no recent failures' and the tick proceeds during the saturation the guard\n" +
        "exists to detect. Destructure `error:` and route it into the existing catch.",
    ).toEqual([])
  })

  it("every throttled route acts on that error before comparing the count", () => {
    // Destructuring alone is not the fix — the error has to change control flow,
    // and it has to do so BEFORE the threshold comparison, or the tick has already
    // been allowed through.
    for (const { file, src } of throttledRoutes()) {
      const guardAt = src.search(/if\s*\(\s*\w*throttleErr\w*\s*\)/)
      const compareAt = src.search(/if\s*\(\(count\s*\?\?\s*0\)\s*>\s*SATURATION_FAIL_THRESHOLD\)/)
      expect(guardAt, `${file}: no error guard found`).toBeGreaterThan(-1)
      expect(compareAt, `${file}: no threshold comparison found`).toBeGreaterThan(-1)
      expect(guardAt, `${file}: the error guard must precede the threshold comparison`).toBeLessThan(compareAt)
    }
  })

  it("the error is surfaced as a real Error, not stringified into [object Object]", () => {
    // The existing catch renders `e instanceof Error ? e.message : String(e)`. A
    // PostgREST error is a plain object, so `throw throttleErr` would log
    // "throttle_read: [object Object]" — the failure would be visible but
    // undiagnosable, which is its own small version of this class.
    for (const { file, src } of throttledRoutes()) {
      expect(src, `${file}: wrap the throttle error in an Error so its message survives`)
        .toMatch(/throw new Error\(\s*\w*throttleErr\w*\.message/)
    }
  })

  it("the failure is logged where an observer will actually look for it", () => {
    // ⚠ The nine routes record a throttle failure as `extra: { skipped:
    // "throttle_error" }`, and that is the key any query keys on. The shared lib
    // logged an EMPTY `extra`, so its two pipelines' failures would have been
    // invisible to the obvious query even after the fail-open was fixed — the
    // same "the instrument cannot see it" defect one layer down. Fixing a guard
    // without fixing its record leaves the incidence unmeasurable.
    for (const { file, src } of throttledRoutes()) {
      const at = src.indexOf("throttle_read:")
      expect(at, `${file}: no throttle_read log line`).toBeGreaterThan(-1)
      // 🚨 THE WINDOW STOPS AT THE `return`, AND MUTATION IS WHY. The very next
      // statement is `return NextResponse.json({ ok: false, skipped:
      // "throttle_error", … })`, which contains the same string — so a window
      // that ran past it passed even with the log's `extra` emptied back to `{}`.
      // The HTTP body is not the record; `pipeline_runs` is.
      const ret = src.indexOf("return", at)
      const logCall = src.slice(at, ret > at ? ret : at + 260)
      expect(
        logCall,
        `${file}: the throttle-failure LOG CALL must carry skipped: "throttle_error" in its extra, or the failure is invisible to the query everyone writes (the HTTP response body does not count — it is not persisted)`,
      ).toMatch(/skipped:\s*["']throttle_error["']/)
    }
  })
})
