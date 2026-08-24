import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, sep } from "node:path"

// RATCHET — an edge function's `pipeline_runs` insert must not discard its error.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `supabase-js RETURNS errors rather than throwing`. CLAUDE.md names this as the
// engine of this repo's most productive defect class: a failed read or write
// resolves to `{ data: null, error }`, so `await sb.from(X).insert(...)` with the
// result discarded is a SILENT SUCCESS. `try/catch` does not help — nothing throws.
//
// On a TELEMETRY write that is especially bad, because the failure mode is
// indistinguishable from the pipeline never having run:
//
//   insert fails  →  no pipeline_runs row  →  every arm keyed on pipeline_runs
//                    reports `cron_silent`  →  reads as "the scheduler stopped"
//
// This repo already has arms that key on exactly that (`detect_stalled_pipelines`,
// `get_pipeline_alerts`), and `pipeline_runs` is already documented as a
// null-instrument in other ways (`rows_written = 0` has three incompatible
// meanings). A telemetry write that can fail silently makes the instrument worse.
//
// ── WHY A RATCHET AND NOT A BAN AT ZERO ─────────────────────────────────────
// ⚠ Three call sites currently discard the error, and they CANNOT be fixed from
// the repo alone: fixing the source without deploying would add repo-vs-prod
// drift, which is its own tracked issue (known-issues #23 / #31), and edge-function
// deploys are gated on a known gate-key rotation blocker. A ban at zero would be
// permanently red — the "permanently-red arm" failure this repo has already paid
// for once.
//
// So: a DOWN-ONLY ratchet. It cannot stop the three; it stops a FOURTH.
// ⚠ LOWER THIS NUMBER IN THE SAME COMMIT THAT FIXES ONE. Never raise it.
const MAX_UNCHECKED = 3

// ⓘ POSITIVE CONTROL, and it is what makes the ratchet meaningful: two call sites
// in this same tree DO check (`hybrid-custody-backfill`, `hybrid-custody-events`
// both destructure `error` and log it). The correct shape is already present and
// achievable here — this is not a limitation of the platform.
const MIN_CHECKED = 2

const ROOT = "supabase/functions"

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    // ⚠ SKIP VENDORED TREES. Several function dirs carry their own node_modules,
    // and walking them took the population from ~40 files to 1,756 — a ratchet
    // over a population that includes third-party source is measuring the wrong
    // thing, and it can only ever drift upward as dependencies change.
    if (e === "node_modules" || e === ".git" || e === "dist") continue
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (e.endsWith(".ts")) out.push(p.split(sep).join("/"))
  }
  return out
}

export type Site = { file: string; line: number; checked: boolean }

/**
 * Every `pipeline_runs` INSERT call site, classified by whether the awaited
 * result's `error` is destructured.
 *
 * ⚠ Deliberately simple, and proven on fixtures below in BOTH directions. A
 * cleverer parser is not the point — an unprovable detector is worse than a
 * blunt one, and a regex that silently matches nothing reads as "all clean".
 */
export function pipelineRunInsertSites(src: string, file = "<mem>"): Site[] {
  const out: Site[] = []
  const needle = '.from("pipeline_runs")'
  let i = src.indexOf(needle)
  while (i >= 0) {
    // Only INSERTs. A read of pipeline_runs is a different question.
    if (/\.insert\s*\(/.test(src.slice(i, i + 400))) {
      // Walk back to the start of the statement, then ask whether this
      // statement destructures `error` from the awaited call.
      // ⚠ CUT ON `;` ONLY — never on `{` or `}`. The first version also cut at
      // the last brace, which severs the destructuring pattern `{ error }` that
      // is the very thing being detected: the tail became ` = await supabase`
      // and EVERY site classified as unchecked. The regex is anchored at `$`, so
      // only the text immediately preceding the call can match anyway.
      const before = src.slice(Math.max(0, i - 300), i)
      const cut = before.lastIndexOf(";")
      const lhs = before.slice(cut + 1).replace(/\s+/g, " ")
      // ⚠ The tail is `= await supabase` (or `= await sb`), NOT `= await` — the
      // receiver identifier sits between the await and the `.from(` we anchored
      // on. The first version of this regex omitted it and classified EVERY site
      // as unchecked, including its own CHECKED fixture. That fixture is the only
      // reason it was caught, which is the argument for proving a detector in
      // both directions rather than only on the offender.
      const checked = /\{[^}]*\berror\b[^}]*\}\s*=\s*(await\s+)?[\w$]*$/.test(lhs)
      out.push({ file, line: src.slice(0, i).split("\n").length, checked })
    }
    i = src.indexOf(needle, i + 1)
  }
  return out
}

const SITES = walk(ROOT).flatMap((f) => pipelineRunInsertSites(readFileSync(f, "utf8"), f))

describe("edge-function pipeline_runs inserts do not discard their error", () => {
  it("the walk found the call sites (not vacuously passing)", () => {
    // ⚠ A ratchet over an empty population passes forever. Assert the count it
    // inspected, which is the failure this repo has hit more than once.
    expect(SITES.length, "no pipeline_runs INSERT sites found — did the call shape change?").toBeGreaterThanOrEqual(5)
  })

  it("the CORRECT shape is present in this tree — the positive control", () => {
    // Without this, the ratchet is consistent with "checking is impossible here".
    const checked = SITES.filter((s) => s.checked)
    expect(checked.length, "no call site checks its error — the detector is probably broken").toBeGreaterThanOrEqual(
      MIN_CHECKED,
    )
  })

  it(`RATCHET: at most ${MAX_UNCHECKED} inserts discard their error`, () => {
    const unchecked = SITES.filter((s) => !s.checked)
    expect(
      unchecked.length,
      `${unchecked.length} pipeline_runs INSERT(s) discard the returned error, ratchet is ${MAX_UNCHECKED}. ` +
        `supabase-js RETURNS errors rather than throwing, so a failed telemetry write is a SILENT success and ` +
        `the pipeline becomes indistinguishable from one that never ran. Destructure { error } and log it — ` +
        `hybrid-custody-events does exactly that. LOWER the ratchet when you fix one; never raise it:\n` +
        unchecked.map((s) => `  ${s.file}:${s.line}`).join("\n"),
    ).toBeLessThanOrEqual(MAX_UNCHECKED)
  })

  it("the detector fires on the unchecked shape and clears on the checked one", () => {
    // ⚠ Proven against BOTH, because a detector that never fires and a detector
    // that always fires are both green until someone checks.
    const UNCHECKED = `async function logRun() {\n  await supabase.from("pipeline_runs").insert({ pipeline: "x" })\n}`
    const CHECKED = `async function logRun() {\n  const { error } = await supabase.from("pipeline_runs").insert({ pipeline: "x" })\n  if (error) console.log(error.message)\n}`
    expect(pipelineRunInsertSites(UNCHECKED).map((s) => s.checked)).toEqual([false])
    expect(pipelineRunInsertSites(CHECKED).map((s) => s.checked)).toEqual([true])

    // A READ must not be counted — it is a different question and would inflate
    // the population, which is how a ratchet quietly stops meaning anything.
    const READ = `const { data } = await supabase.from("pipeline_runs").select("id").limit(1)`
    expect(pipelineRunInsertSites(READ)).toEqual([])
  })
})
