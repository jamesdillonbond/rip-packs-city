import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { compare, countFindings } from "../scripts/check-deno-lint-ratchet.mjs"

// scripts/check-deno-lint-ratchet.mjs gates `deno lint` over supabase/functions
// in CI (it was `|| true` until 2026-09-25 and could never fail). Planted-defect
// proof on that date: a `let` never reassigned in match-topshot-players →
// `prefer-const|…: 0 → 1`, exit 1.

const ROOT = path.resolve(__dirname, "..")

describe("deno lint ratchet", () => {
  it("counts per rule and repo-relative file, from file:// URLs", () => {
    const report = {
      diagnostics: [
        { code: "prefer-const", filename: `file://${ROOT}/supabase/functions/a/index.ts` },
        { code: "prefer-const", filename: `file://${ROOT}/supabase/functions/a/index.ts` },
        { code: "no-empty", filename: `${ROOT}/supabase/functions/b/index.ts` },
      ],
    }
    expect(countFindings(report, ROOT)).toEqual({
      "prefer-const|supabase/functions/a/index.ts": 2,
      "no-empty|supabase/functions/b/index.ts": 1,
    })
  })

  it("fails a new key and a grown key; reports a shrink without failing", () => {
    const base = { "r|a": 2, "r|b": 1 }
    expect(compare({ "r|a": 2, "r|b": 1 }, base)).toEqual({ grown: [], shrunk: [] })
    expect(compare({ "r|a": 3, "r|b": 1 }, base).grown).toEqual([{ key: "r|a", baseline: 2, now: 3 }])
    expect(compare({ "r|a": 2, "r|b": 1, "r|c": 1 }, base).grown).toEqual([{ key: "r|c", baseline: 0, now: 1 }])
    // Moving a finding to another file is a new key even though the total is flat.
    expect(compare({ "r|a": 1, "r|b": 1, "r|c": 1 }, base).grown).toHaveLength(1)
    const { grown, shrunk } = compare({ "r|a": 1 }, base)
    expect(grown).toEqual([])
    expect(shrunk.map((s: { key: string }) => s.key)).toEqual(["r|a", "r|b"])
  })

  it("the baseline only names files that exist", () => {
    const baseline = JSON.parse(readFileSync(path.join(ROOT, "deno-lint-ratchet.json"), "utf8"))
    const keys = Object.keys(baseline)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) {
      const file = k.split("|")[1]
      expect(() => readFileSync(path.join(ROOT, file)), `${k} names a missing file`).not.toThrow()
    }
  })

  it("CI runs the ratchet on deno lint's JSON, and nothing else swallows the exit", () => {
    const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, any> }
    const runs: string[] = wf.jobs["edge-deno"].steps.map((s: any) => s.run).filter(Boolean)
    const step = runs.find((r) => /check-deno-lint-ratchet/.test(r))
    expect(step, "edge-deno must run the deno lint ratchet").toBeTruthy()
    expect(step).toMatch(/deno lint --json/)
    const ratchetLine = step!.split("\n").find((l) => /check-deno-lint-ratchet/.test(l))!
    expect(ratchetLine).not.toMatch(/\|\|\s*true/)
  })
})
