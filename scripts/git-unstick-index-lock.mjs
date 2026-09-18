#!/usr/bin/env node
// Diagnose — and only then clear — a STALE .git/index.lock.
//
// ⛔ WHY THIS EXISTS. A 0-byte `.git/index.lock` has now blocked commits on this
// box THREE times (2026-08-23, 2026-09-05, 2026-09-18), roughly fortnightly. The
// first cost a DAY of untracked work: a retraction, four inbox filings and eight
// production migrations piled up because every `git add`/`git commit` died with
//
//     fatal: Unable to create '.../.git/index.lock': File exists.
//     Another git process seems to be running in this repository, or the lock
//     file may be stale
//
// ⚠ THAT MESSAGE NAMES THE DANGEROUS CASE FIRST, and this repo's standing rule is
// that a parallel session may be mid-write — so the CORRECT reflex (leave another
// session's lock alone) is exactly what lets a stale lock persist for a day.
// The message is not evidence either way. The recipe below is.
//
// ⭐ AGE IS A HINT, NEVER THE VERDICT. The 09-05 recurrence was 76 SECONDS old,
// so "a real in-flight lock is seconds old" argues to leave it — wrongly. The
// discriminators that actually work, all three together:
//   1. ZERO BYTES — a live git writes index content into the lock.
//   2. NO git PROCESS — the single strongest signal. A lock with no holder is
//      orphaned by definition, whatever its age.
//   3. A FROZEN mtime across two samples — proves nothing is progressing.
//
// ⛔ It REFUSES on any disagreement rather than guessing, and `--check` never
// removes anything. Exit 0 = nothing to do or cleared; 1 = a lock it will not
// touch; 2 = usage/environment error.

import { existsSync, statSync, unlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const LOCK = join(process.cwd(), ".git", "index.lock")
const CHECK_ONLY = process.argv.includes("--check")
const SAMPLE_MS = Number(process.env.UNSTICK_SAMPLE_MS ?? 45_000)

export function gitProcessCount() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq git.exe", "/NH"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return (out.match(/git\.exe/gi) || []).length
    }
    const out = execFileSync("ps", ["-eo", "comm"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.split("\n").filter((l) => l.trim() === "git").length
  } catch {
    // ⚠ Probe failure is NOT "no processes". Returning 0 here would turn a broken
    // environment into a green light to delete, which is the fail-open this whole
    // script exists to avoid.
    return null
  }
}

/** Pure decision, so the rule is testable without a real .git. */
export function verdict({ bytes, procs, mtimeA, mtimeB }) {
  const reasons = []
  if (bytes !== 0) reasons.push(`lock is ${bytes} bytes, not 0 — a live git wrote to it`)
  if (procs === null) reasons.push("could not enumerate git processes — refusing to guess")
  else if (procs > 0) reasons.push(`${procs} git process(es) running — there IS a holder`)
  if (mtimeA !== mtimeB) reasons.push(`mtime advanced ${mtimeA} -> ${mtimeB} — something is progressing`)
  return { stale: reasons.length === 0, reasons }
}

function main() {
  if (!existsSync(LOCK)) {
    console.log("no .git/index.lock — nothing to do")
    return 0
  }
  const st = statSync(LOCK)
  const bytes = st.size
  const ageS = Math.round((Date.now() - st.mtimeMs) / 1000)
  const procs = gitProcessCount()
  const mtimeA = st.mtimeMs

  console.log(`index.lock present: ${bytes} bytes, age ${ageS}s, git processes: ${procs ?? "UNKNOWN"}`)
  if (bytes !== 0 || procs === null || procs > 0) {
    const { reasons } = verdict({ bytes, procs, mtimeA, mtimeB: mtimeA })
    console.error(`⛔ NOT stale — leaving it alone:\n  - ${reasons.join("\n  - ")}`)
    return 1
  }

  // Only now is the second mtime sample worth its wait.
  console.log(`sampling mtime again in ${Math.round(SAMPLE_MS / 1000)}s to prove nothing is progressing…`)
  const until = Date.now() + SAMPLE_MS
  while (Date.now() < until) { /* deliberate busy-wait: no deps, and this runs at most once */ }
  if (!existsSync(LOCK)) {
    console.log("lock disappeared during the sample — a real writer finished. Nothing to do.")
    return 0
  }
  const mtimeB = statSync(LOCK).mtimeMs
  const { stale, reasons } = verdict({ bytes, procs, mtimeA, mtimeB })
  if (!stale) {
    console.error(`⛔ NOT stale — leaving it alone:\n  - ${reasons.join("\n  - ")}`)
    return 1
  }
  if (CHECK_ONLY) {
    console.log("✅ STALE by all three checks. --check given, so nothing was removed.")
    return 0
  }
  unlinkSync(LOCK)
  console.log("✅ STALE by all three checks — removed. Re-run your git command.")
  console.log("⚠ Before trusting the result, confirm HEAD is pushed and the only")
  console.log("  uncommitted work is your own: git log --oneline -1 && git status")
  return 0
}

// ⛔ Compared as a FILE URL, never a raw string. `import.meta.url` is always a URL
// while `process.argv[1]` is an OS path, so `file://` + argv[1] is never equal on
// Windows — main() would silently never run and the process would exit 0 having
// done nothing. Banned at zero by
// __tests__/scripts-main-module-guard-works-on-windows.test.ts, which caught this
// exact line in review.
const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  process.exit(main())
}
