#!/usr/bin/env node
// Diagnose — and only then clear — a STALE git lock file (.git/index.lock,
// HEAD.lock, packed-refs.lock, refs/**/*.lock).
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
//
// ⚠ NOT ONLY index.lock (2026-09-18). A Cowork commit against the mount left a
// stale `.git/HEAD.lock` that blocked HEAD from moving for ~40 minutes: the
// commit SUCCEEDED, and only the lock's cleanup unlink failed, because the mount
// refuses deletes until the user approves them. That lock is NOT zero bytes — a
// ref lock holds the new ref value, and after the rename-as-copy its content is
// byte-identical to the target it was meant to become. So for REF-STYLE locks
// (HEAD.lock, packed-refs.lock, refs/**/*.lock) signal 1 is satisfied EITHER by
// zero bytes OR by content equal to the target's current content — a finished
// write whose cleanup died. Content that DIFFERS from the target is a write in
// flight, and is refused exactly as before. The candidates are WALKED (every
// `*.lock` under .git except objects/, whose pack locks are gc's own), not
// listed, so the next lock file git invents is inside this check by construction.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const GIT_DIR = join(process.cwd(), ".git")
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

/**
 * Every `*.lock` under a git dir that this script may judge, as paths relative
 * to it. objects/ is excluded (pack/ref-pack locks belong to gc and repack).
 */
export function findLocks(gitDir) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (r === "objects") continue
        walk(join(dir, e.name), r)
      } else if (e.name.endsWith(".lock")) {
        out.push(r)
      }
    }
  }
  walk(gitDir, "")
  return out.sort()
}

/**
 * Pure decision, so the rule is testable without a real .git.
 * `contentMatchesTarget` is the ref-lock escape from signal 1: a lock whose
 * bytes equal its target's current bytes is a finished write, not a live one.
 */
export function verdict({ bytes, procs, mtimeA, mtimeB, contentMatchesTarget = false }) {
  const reasons = []
  if (bytes !== 0 && !contentMatchesTarget)
    reasons.push(`lock is ${bytes} bytes, not 0, and differs from its target — a live git wrote to it`)
  if (procs === null) reasons.push("could not enumerate git processes — refusing to guess")
  else if (procs > 0) reasons.push(`${procs} git process(es) running — there IS a holder`)
  if (mtimeA !== mtimeB) reasons.push(`mtime advanced ${mtimeA} -> ${mtimeB} — something is progressing`)
  return { stale: reasons.length === 0, reasons }
}

function targetOf(rel) {
  // index.lock has no textual target; ref-style locks become the file minus ".lock".
  return rel === "index.lock" ? null : join(GIT_DIR, rel.slice(0, -".lock".length))
}

function contentMatches(rel) {
  const target = targetOf(rel)
  if (target === null || !existsSync(target)) return false
  try {
    return readFileSync(join(GIT_DIR, rel)).equals(readFileSync(target))
  } catch {
    return false
  }
}

function main() {
  const locks = findLocks(GIT_DIR)
  if (locks.length === 0) {
    console.log("no *.lock under .git — nothing to do")
    return 0
  }
  const procs = gitProcessCount()
  const first = new Map()
  let refused = 0
  for (const rel of locks) {
    const p = join(GIT_DIR, rel)
    const st = statSync(p)
    const bytes = st.size
    const ageS = Math.round((Date.now() - st.mtimeMs) / 1000)
    const contentMatchesTarget = contentMatches(rel)
    console.log(
      `${rel} present: ${bytes} bytes${contentMatchesTarget ? " (identical to its target)" : ""}, age ${ageS}s, git processes: ${procs ?? "UNKNOWN"}`,
    )
    const { reasons } = verdict({ bytes, procs, mtimeA: st.mtimeMs, mtimeB: st.mtimeMs, contentMatchesTarget })
    if (reasons.length > 0) {
      console.error(`⛔ ${rel} NOT stale — leaving it alone:\n  - ${reasons.join("\n  - ")}`)
      refused++
      continue
    }
    first.set(rel, { bytes, mtimeA: st.mtimeMs, contentMatchesTarget })
  }
  if (first.size === 0) return 1

  // Only now is the second mtime sample worth its wait — once, for every candidate.
  console.log(`sampling mtime again in ${Math.round(SAMPLE_MS / 1000)}s to prove nothing is progressing…`)
  const until = Date.now() + SAMPLE_MS
  while (Date.now() < until) { /* deliberate busy-wait: no deps, and this runs at most once */ }

  let cleared = 0
  for (const [rel, a] of first) {
    const p = join(GIT_DIR, rel)
    if (!existsSync(p)) {
      console.log(`${rel} disappeared during the sample — a real writer finished. Nothing to do.`)
      continue
    }
    const mtimeB = statSync(p).mtimeMs
    const { stale, reasons } = verdict({ ...a, mtimeB })
    if (!stale) {
      console.error(`⛔ ${rel} NOT stale — leaving it alone:\n  - ${reasons.join("\n  - ")}`)
      refused++
      continue
    }
    if (CHECK_ONLY) {
      console.log(`✅ ${rel} STALE by every check. --check given, so nothing was removed.`)
      continue
    }
    unlinkSync(p)
    cleared++
    console.log(`✅ ${rel} STALE by every check — removed.`)
  }
  if (cleared > 0) {
    console.log("Re-run your git command. ⚠ Before trusting the result, confirm HEAD is pushed and the only")
    console.log("  uncommitted work is your own: git log --oneline -1 && git status")
  }
  return refused > 0 ? 1 : 0
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
