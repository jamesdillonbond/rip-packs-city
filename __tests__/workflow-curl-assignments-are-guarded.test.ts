// Every `VAR=$(curl ...)` in a GitHub Actions `run:` block must carry a `|| VAR=""`
// fallback.
//
// ── WHY, and it is not hypothetical ────────────────────────────────────────
// Every `run:` block executes under `bash -e`, so **a fallible command inside an
// ASSIGNMENT aborts the step at that line**. `curl` exits non-zero on a timeout
// (28), a DNS failure (6), a connection reset (7) — none of which are HTTP
// statuses, so none of them reach the `if [ "$STATUS" != "200" ]` check written
// directly underneath. That check, its `::warning::`, its `OVERALL=1` and its
// `break` are all **dead code on exactly the failures they were written for**.
//
// Observed 2026-08-30, run 33313722968 (`Offer-Fill Sales Backfill`): the step's
// entire output was
//     ── call 1/15  url=…?sync=1
//     ##[error]Process completed with exit code 28
// `curl --max-time 280` timed out, the assignment aborted, and **not one line of
// the handler ran** — no `HTTP $STATUS`, no warning, no annotation naming the
// endpoint. The job failed as an opaque `28`.
//
// ⭐ THE PART WORTH KEEPING: this repo had ALREADY LEARNED THIS TRAP AND FIXED
// THE WRONG HALF. `offer-fill-backfill.yml` and `allow-list-reconcile.yml` both
// carry a careful comment explaining `bash -e` + assignment… attached to the
// `jq` call, while the `curl` assignment three lines above it stayed unguarded.
// The lesson was applied at the SITE where it was observed instead of to the
// CLASS — which is why this guard keys on the shape, not on `jq`.
//
// 9 of the 24 sites were already guarded (`rpc-pipeline`, `ops-monitor`,
// `pipeline-sentinel`); the other 15 were fixed in the same commit as this test,
// so this is a BAN AT ZERO rather than a ratchet.
//
// ⚠ 2026-09-03: ten of those sites moved into ONE composite action,
// `.github/actions/rpc-call`, and this guard's non-vacuity floor (> 15 sites in
// workflows/) went red on the commit that shipped it — the guard punished its
// own success, exactly the CLAUDE.md shape "a not-vacuous check must be
// satisfiable at a population of ZERO". The walk now covers BOTH roots
// (workflows/*.yml and actions/*/action.yml), the floor is re-derived from the
// population as it stands, and the composite root must CONTRIBUTE, so a future
// move in either direction stays inside the guard.

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOWS = join(process.cwd(), ".github", "workflows")
const ACTIONS = join(process.cwd(), ".github", "actions")

/** Assignment sites and whether the command substitution's closing line has a `||` fallback. */
export function findCurlAssignments(src: string): { line: number; varName: string; guarded: boolean }[] {
  const lines = src.split("\n")
  const out: { line: number; varName: string; guarded: boolean }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(curl\b/)
    if (!m) continue
    const varName = m[1]
    // Walk to the line that closes the substitution (paren balance returns to 0).
    let depth = 0
    let end = -1
    for (let j = i; j < lines.length && j < i + 15; j++) {
      for (const ch of lines[j]) {
        if (ch === "(") depth++
        else if (ch === ")") depth--
      }
      if (depth === 0) { end = j; break }
    }
    if (end === -1) { out.push({ line: i + 1, varName, guarded: false }); continue }
    out.push({ line: i + 1, varName, guarded: /\|\|/.test(lines[end]) })
    i = end
  }
  return out
}

describe("GitHub Actions: curl assignments cannot abort the step under bash -e", () => {
  const workflowFiles = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ label: `workflows/${f}`, path: join(WORKFLOWS, f) }))
  const actionFiles = readdirSync(ACTIONS).map((d) => ({
    label: `actions/${d}/action.yml`,
    path: join(ACTIONS, d, "action.yml"),
  }))
  const files = [...workflowFiles, ...actionFiles]
  const all = files.flatMap((f) =>
    findCurlAssignments(readFileSync(f.path, "utf8")).map((s) => ({ ...s, file: f.label })),
  )

  it("inspected a non-trivial number of workflows and sites, from BOTH roots", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    expect(workflowFiles.length).toBeGreaterThan(10)
    // Floor re-derived 2026-09-03: 16 sites across both roots (workflows 15 +
    // composite 1) after the ten-site move into .github/actions/rpc-call.
    expect(all.length).toBeGreaterThanOrEqual(10)
    // ⚠ The SECOND root must contribute: the composite holds the curl that ten
    // workflows used to carry, so a walk that only saw workflows/ would miss the
    // one copy that now matters most.
    expect(all.filter((s) => s.file.startsWith("actions/")).length).toBeGreaterThanOrEqual(1)
  })

  it("POSITIVE CONTROL — an unguarded assignment is detected", () => {
    const bad = ['        STATUS=$(curl -s -o /tmp/x.json -w "%{http_code}" \\', '          "$URL")'].join("\n")
    const found = findCurlAssignments(bad)
    expect(found).toHaveLength(1)
    expect(found[0].guarded).toBe(false)
  })

  it("NEGATIVE CONTROL — a guarded assignment is accepted", () => {
    const good = ['        STATUS=$(curl -s -o /tmp/x.json -w "%{http_code}" \\', '          "$URL") || STATUS=""'].join("\n")
    expect(findCurlAssignments(good)[0].guarded).toBe(true)
  })

  it("BAN AT ZERO — no unguarded `VAR=$(curl …)` in any workflow", () => {
    const unguarded = all.filter((s) => !s.guarded)
    expect(
      unguarded.map((s) => `${s.file}:${s.line} (${s.varName})`),
      "Under `bash -e` a curl timeout/DNS failure aborts the step AT THE ASSIGNMENT, so the\n" +
        "`!= 200` check, its ::warning:: and its break below are dead code on exactly the\n" +
        "failures they exist for. Observed as an opaque `exit 28` in run 33313722968.\n" +
        'Fix: append `|| VAR=""` to the line closing the command substitution; the existing\n' +
        "non-200 branch then reports it, because an empty string is not 200.\n",
    ).toEqual([])
  })
})
