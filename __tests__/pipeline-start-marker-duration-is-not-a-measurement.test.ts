// __tests__/pipeline-start-marker-duration-is-not-a-measurement.test.ts
//
// `pipeline_runs.duration_ms` is GENERATED ALWAYS AS
//   GREATEST(0, (EXTRACT(epoch FROM (finished_at - started_at)) * 1000)::integer)
// and `finished_at` is NOT NULL DEFAULT now().
//
// So a "start marker" row — inserted up front so a run killed at maxDuration
// leaves a trace — publishes `finished_at = now()` unless it says otherwise, and
// its generated `duration_ms` becomes the latency of THE MARKER'S OWN INSERT.
// That number looks exactly like a measurement of the run and is not one.
//
// It has already cost a wrong diagnosis: a deep audit read
// drain-conflated-subeditions' markers (147/176/185 ms) as the route "dying
// instantly", when the route in fact runs to its 300s ceiling and is killed —
// the opposite conclusion, and it points at a different fix. Measured live
// 2026-08-15, the same shape sat on 514 fmv-recalc-heartbeat rows publishing
// 42ms-56s of pure insert latency.
//
// The fix is to pin finished_at = started_at on the marker so duration_ms is a
// hard 0: an obvious sentinel nobody reads as a duration. This guard pins that,
// derived by scanning for the marker pattern rather than naming files, so a new
// start-marker writer is covered the day it lands.

import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { execSync } from "child_process"

/** Every route that writes a `phase: "started"` marker row. */
function markerWriters(): string[] {
  const out = execSync(
    `grep -rl 'phase: "started"' app --include=route.ts || true`,
    { cwd: process.cwd(), encoding: "utf8" }
  ).trim()
  return out ? out.split("\n") : []
}

/** The object literal passed to the marker .insert(...), roughly bounded. */
function markerInsertBlock(src: string): string | null {
  const idx = src.indexOf('phase: "started"')
  if (idx === -1) return null
  // Walk back to the nearest `.insert(` that precedes it.
  const before = src.slice(0, idx)
  const ins = before.lastIndexOf(".insert(")
  if (ins === -1) return null
  return src.slice(ins, idx)
}

describe("a start marker must not publish its own insert latency as duration_ms", () => {
  const writers = markerWriters()

  it("finds the marker writers (not vacuous)", () => {
    expect(writers.length).toBeGreaterThan(0)
    // The route whose misread motivated this guard must be among them.
    expect(writers.some((f) => f.includes("drain-conflated-subeditions"))).toBe(true)
  })

  it.each(writers)("%s pins finished_at on its start marker", (file) => {
    const block = markerInsertBlock(readFileSync(file, "utf8"))
    expect(block, `no marker .insert( found in ${file}`).not.toBeNull()
    // Must set finished_at explicitly; otherwise the NOT NULL DEFAULT now()
    // fires and duration_ms silently becomes insert latency.
    expect(
      /finished_at\s*:/.test(block as string),
      `${file}: start marker omits finished_at, so duration_ms will publish the ` +
        `marker's own insert latency as if it were the run's duration`
    ).toBe(true)
  })

  it("drain-conflated-subeditions persists step progress DURING the run", () => {
    // Its header instructs: "If a tick nears the ceiling, read step_ms and bound
    // THAT step." That was self-defeating — step_ms was written only by the
    // completion update, so on the one outcome it was built for (a maxDuration
    // kill) it was never persisted at all. The route has been killed on every
    // tick since 2026-07-31 and has therefore never named the step that overran.
    const src = readFileSync(
      "app/api/admin/drain-conflated-subeditions/route.ts",
      "utf8"
    )
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

    // mark() must be async and write to pipeline_runs, not just mutate a local.
    expect(code).toMatch(/const\s+mark\s*=\s*async\s*\(/)
    const markBody = code.slice(code.indexOf("const mark = async ("))
    expect(markBody.slice(0, 600)).toMatch(/from\("pipeline_runs"\)[\s\S]{0,120}\.update\(/)
    expect(markBody.slice(0, 600)).toMatch(/last_step/)

    // ⚠ and it must NOT set finished_at, or every persisted step would convert
    // the marker's 0 sentinel back into a fake duration — the defect above.
    expect(markBody.slice(0, 600)).not.toMatch(/finished_at/)

    // Every call site must await it, or the update races the next step / the kill.
    const calls = code.match(/^\s*(await\s+)?mark\(/gm) ?? []
    expect(calls.length).toBeGreaterThan(5)
    for (const c of calls) {
      expect(c, `un-awaited mark() call: ${c.trim()}`).toMatch(/await/)
    }
  })

  it("the generated-column arithmetic makes the sentinel exactly 0", () => {
    // Mirrors the DDL: GREATEST(0, (epoch(finished_at - started_at) * 1000)::int).
    const durationMs = (startedAt: number, finishedAt: number) =>
      Math.max(0, Math.trunc(((finishedAt - startedAt) / 1000) * 1000))

    const t = 1_786_800_000_000
    // Pinned marker -> hard 0, unmistakable as a duration.
    expect(durationMs(t, t)).toBe(0)
    // Defaulted marker -> a plausible-looking number that is pure insert cost.
    expect(durationMs(t, t + 147)).toBe(147)
  })
})
