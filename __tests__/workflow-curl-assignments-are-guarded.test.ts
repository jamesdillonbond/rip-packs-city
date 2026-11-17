// Every `VAR=$(<detector> ...)` in a GitHub Actions `run:` block must treat "no
// answer" as its own state — never as the clean value.
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
//
// ── 🚨 2026-09-18: THE GUARD'S OWN COMMENT WAS THE NEXT INSTANCE ──────────────
//
// The paragraph above says this guard "keys on the shape, not on `jq`". **It did
// not.** It keyed on `curl` — another single command. The CLASS is *a detector
// whose answer a guard then acts on*, and CLAUDE.md names `jq` as a member in the
// same breath ("and `jq` counts (exit 5 on a non-JSON body)"). Walking the real
// population found the class alive in `ci.yml`, in the two jobs whose entire
// purpose is to catch a silent no-op — **three sibling pairs, each with one call
// failing CLOSED and one failing OPEN AS CLEAN**:
//
//   1. `FD=$(node find-future-dated-ledger-headings.mjs …)` — unguarded, then read
//      through `${FD:-0}`, six lines from `CLOB=$(node …) || CLOB=""` + an
//      explicit "it did not run" error. A dead detector rendered as "0
//      future-dated headings" = clean.
//   2. `SW_BEFORE=$(git show HEAD~1:… | awk -f …)` — a PIPE, and that step sets no
//      `pipefail` (GitHub's default shell is `bash -e {0}`, `-e` only). A failing
//      `git show` was invisible: awk read empty stdin and printed `0`. With three
//      pre-existing swallowed headings in the ledger that made the delta `3 > 0`
//      — a **FALSE ALARM** telling the pusher their entry spliced on a substring
//      when it had not. Reproduced 2026-09-18: old shape exit 1, new shape exit 0.
//   3. `LOST_R=$(node "$DETECT" …) || LOST_R="0"` — the worst of the three,
//      because it does not abort: it **substitutes the clean value and carries
//      on**, incrementing `INSPECTED` so the job reports a clean inspection of a
//      filing it never read, while the sibling call twelve lines below already
//      failed closed on the same condition.
//
// ⭐ The transferable half: a guard's claim about its own coverage is itself a
// claim, and this one was written down, believed, and untested for six weeks.
// **"Keys on the shape" is only true if the walk enumerates the shape's members.**
//
// ⚠ Arm 3 (`${VAR:-0}`) is DIRECTION-SENSITIVE and must stay that way. `${n:-0}
// -lt 60` is fail-CLOSED — a dead detector reads as 0, 0 < 60, the guard reds,
// which is correct and must not be flagged. `${FD:-0} -gt 0` is fail-OPEN — a
// dead detector reads as 0, 0 > 0 is false, the guard passes. Only the second is
// the defect, so the check keys on the COMPARISON, not on the default.

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const WORKFLOWS = join(process.cwd(), ".github", "workflows")
const ACTIONS = join(process.cwd(), ".github", "actions")

/**
 * Commands whose exit status is real and whose stdout a guard then ACTS ON.
 * `echo`/`printf`/`dirname` are deliberately absent: they do not fail, so a
 * fallback on them is noise, and a guard that flags noise gets ignored.
 */
export const DETECTOR_COMMANDS = ["curl", "node", "jq", "awk"] as const

export type Assignment = {
  line: number
  varName: string
  command: string
  /** the substitution's closing line carries a `|| …` fallback at all */
  guarded: boolean
  /** the fallback substitutes a VALUE (`|| V="0"`) rather than emptiness (`|| V=""`) */
  substitutesValue: boolean
}

/** Assignment sites for the given commands, and how each one handles failure. */
export function findAssignments(src: string, commands: readonly string[] = DETECTOR_COMMANDS): Assignment[] {
  const lines = src.split("\n")
  const head = new RegExp(`^\\s*([A-Za-z_][A-Za-z0-9_]*)=\\$\\(\\s*(${commands.join("|")})\\b`)
  const out: Assignment[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(head)
    if (!m) continue
    const [, varName, command] = m
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
    if (end === -1) {
      out.push({ line: i + 1, varName, command, guarded: false, substitutesValue: false })
      continue
    }
    const tail = lines[end]
    const guarded = /\|\|/.test(tail)
    // ⚠ NARROW ON PURPOSE, AND THE NARROWING IS EVIDENCE-BASED. Only a
    // substitution of the literal `0` counts, because in every guard here `0` is
    // the COUNT THAT MEANS CLEAN. A sentinel that means BAD is the correct
    // pattern and must not be flagged — all three live examples were read before
    // this line was narrowed, and all three are fail-CLOSED:
    //   badge-sync.yml            `|| STATUS="000"`  → `000` is the case arm that sets alive=false
    //   topshot-active-listings   `|| STATUS="000"`  → only `"200"` increments OK
    //   ci.yml (GONE, --show)     `|| GONE="(detector failed to list them)"` → `[ -n "$GONE" ]` reports it
    // Flagging those would have punished the right pattern and taught people to
    // delete their fallbacks. They are pinned as negative controls below.
    const substitutesValue = guarded && new RegExp(`\\|\\|\\s*${varName}=\\s*(?:"0"|'0'|0)\\s*$`).test(tail)
    out.push({ line: i + 1, varName, command, guarded, substitutesValue })
    i = end
  }
  return out
}

/** Back-compat alias — this guard began life as a curl-only check. */
export function findCurlAssignments(src: string) {
  return findAssignments(src, ["curl"])
}

/**
 * `${VAR:-0}` used inside a `-gt`/`-ge` comparison: a detector that did not run
 * reads as the CLEAN value and the guard passes. `-lt`/`-le` (a floor) is the
 * fail-closed direction and is deliberately NOT flagged.
 */
export function findFailOpenDefaults(src: string): { line: number; varName: string; text: string }[] {
  const out: { line: number; varName: string; text: string }[] = []
  src.split("\n").forEach((l, i) => {
    if (/^\s*#/.test(l.trim())) return // a comment describing the trap is not the trap
    const m = l.match(/\$\{([A-Za-z_][A-Za-z0-9_]*):-0\}\s*"?\s*-(gt|ge)\b/)
    if (m) out.push({ line: i + 1, varName: m[1], text: l.trim().slice(0, 120) })
  })
  return out
}

describe("GitHub Actions: a detector that did not run must never read as clean", () => {
  const workflowFiles = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ label: `workflows/${f}`, path: join(WORKFLOWS, f) }))
  const actionFiles = readdirSync(ACTIONS).map((d) => ({
    label: `actions/${d}/action.yml`,
    path: join(ACTIONS, d, "action.yml"),
  }))
  const files = [...workflowFiles, ...actionFiles]
  const all = files.flatMap((f) =>
    findAssignments(readFileSync(f.path, "utf8")).map((s) => ({ ...s, file: f.label })),
  )
  const defaults = files.flatMap((f) =>
    findFailOpenDefaults(readFileSync(f.path, "utf8")).map((s) => ({ ...s, file: f.label })),
  )

  it("inspected a non-trivial population, from BOTH roots and MORE THAN ONE command", () => {
    // A walk that silently finds nothing exits clean and reads as coverage.
    expect(workflowFiles.length).toBeGreaterThan(10)
    // Floor re-derived 2026-09-18: 31 sites across both roots
    // (curl 21, node 5, jq 4, awk 1). Kept well below so a consolidation like the
    // 2026-09-03 move into .github/actions/rpc-call cannot red this arm.
    expect(all.length).toBeGreaterThanOrEqual(20)
    // ⚠ The SECOND root must contribute: the composite holds the curl that ten
    // workflows used to carry, so a walk that only saw workflows/ would miss the
    // one copy that now matters most.
    expect(all.filter((s) => s.file.startsWith("actions/")).length).toBeGreaterThanOrEqual(1)
    // ⚠ THE ARM THAT WOULD HAVE CAUGHT THE 2026-09-18 INSTANCES. A walk that
    // finds only `curl` is the curl-only guard again wearing a class-shaped name.
    const commands = new Set(all.map((s) => s.command))
    expect([...commands].sort(), "the walk must span the detector CLASS, not one command").toEqual(
      expect.arrayContaining(["curl", "node"]),
    )
    expect(commands.size).toBeGreaterThanOrEqual(3)
  })

  it("POSITIVE CONTROL — an unguarded assignment is detected, for every command in the class", () => {
    for (const cmd of DETECTOR_COMMANDS) {
      const bad = [`        OUT=$(${cmd} -s something \\`, `          "$ARG")`].join("\n")
      const found = findAssignments(bad)
      expect(found, `${cmd} must be walked`).toHaveLength(1)
      expect(found[0].guarded, `${cmd} must be reported unguarded`).toBe(false)
      expect(found[0].command).toBe(cmd)
    }
  })

  it("NEGATIVE CONTROL — a guarded assignment is accepted", () => {
    const good = ['        STATUS=$(curl -s -o /tmp/x.json -w "%{http_code}" \\', '          "$URL") || STATUS=""'].join("\n")
    const f = findAssignments(good)[0]
    expect(f.guarded).toBe(true)
    expect(f.substitutesValue).toBe(false)
  })

  it("POSITIVE CONTROL — a fallback that SUBSTITUTES the clean value is detected", () => {
    // The real `LOST_R=$(node "$DETECT" …) || LOST_R="0"` shape: guarded, and
    // still wrong, because "0" is the answer meaning "nothing was lost".
    const sneaky = '        LOST_R=$(node "$DETECT" /tmp/a.md /dev/null) || LOST_R="0"'
    const f = findAssignments(sneaky)[0]
    expect(f.guarded, "it does carry a fallback").toBe(true)
    expect(f.substitutesValue, "…and the fallback is a VALUE, which is the defect").toBe(true)
  })

  it("BAN AT ZERO — no unguarded detector assignment in any workflow or composite action", () => {
    const unguarded = all.filter((s) => !s.guarded)
    expect(
      unguarded.map((s) => `${s.file}:${s.line} (${s.varName}=$(${s.command} …))`),
      "Under `bash -e` a detector's failure aborts the step AT THE ASSIGNMENT, so the\n" +
        "check below it, its ::error:: and its remedy are dead code on exactly the\n" +
        "failures they exist for. Observed as an opaque `exit 28` in run 33313722968,\n" +
        "and again on 2026-09-18 in ci.yml's own ledger and inbox guards.\n" +
        'Fix: append `|| VAR=""` to the line closing the command substitution, then test\n' +
        "`[ -z \"$VAR\" ]` explicitly and FAIL — a guard that silently no-ops is\n" +
        "indistinguishable from a passing one.\n",
    ).toEqual([])
  })

  it("NEGATIVE CONTROL — a sentinel meaning BAD is the correct pattern and is NOT flagged", () => {
    // Verbatim shapes from badge-sync.yml, topshot-active-listings-ingest.yml and
    // ci.yml. If narrowing ever drifts back to "any non-empty fallback", these
    // three red — which is the point: the guard must not punish fail-closed code.
    const ok = [
      '          STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$U") || STATUS="000"',
      '            GONE=$(node scripts/find-clobbered-ledger-headings.mjs --show /tmp/a /tmp/b) || GONE="(detector failed to list them)"',
    ]
    for (const line of ok) {
      const f = findAssignments(line)[0]
      expect(f.guarded, line).toBe(true)
      expect(f.substitutesValue, `a sentinel meaning BAD must not be flagged: ${line}`).toBe(false)
    }
  })

  it("BAN AT ZERO — no fallback SUBSTITUTES the value that means 'clean'", () => {
    const subs = all.filter((s) => s.substitutesValue)
    expect(
      subs.map((s) => `${s.file}:${s.line} (${s.varName}=$(${s.command} …) || ${s.varName}=<value>)`),
      "A fallback that substitutes a literal answer is WORSE than an unguarded\n" +
        "assignment: the step does not abort, so the guard carries on and reports a\n" +
        "clean inspection of something it never read. `LOST_R=$(node …) || LOST_R=\"0\"`\n" +
        "did exactly that in ci.yml's inbox guard until 2026-09-18, while the sibling\n" +
        'call twelve lines below already failed closed.\n' +
        'Fix: `|| VAR=""`, then an explicit emptiness check that EXITS NON-ZERO.\n',
    ).toEqual([])
  })

  it("BAN AT ZERO — no `${VAR:-0}` read in a fail-OPEN comparison", () => {
    expect(
      defaults.map((s) => `${s.file}:${s.line} ${s.text}`),
      "`${VAR:-0}` inside a `-gt`/`-ge` test renders a detector that DID NOT RUN as\n" +
        "the clean value: 0 is not greater than 0, so the guard passes. This is the\n" +
        "`?? 0` fabricated-value shape CLAUDE.md bans at zero in application code,\n" +
        "applied to a CI guard.\n" +
        "⚠ `${n:-0} -lt 60` is the OPPOSITE direction and is intentionally allowed —\n" +
        "there a dead detector reads as 0, trips the floor and REDS, which is correct.\n" +
        'Fix: capture with `|| VAR=""`, fail explicitly on empty, then compare bare.\n',
    ).toEqual([])
  })
})
