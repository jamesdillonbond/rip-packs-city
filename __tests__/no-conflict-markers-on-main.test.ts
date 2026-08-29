import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// ── Nothing in this repo checked for conflict markers, and it cost a push to main
//
// 🚨 WHY THIS EXISTS (2026-08-29). A `git stash pop` after a `git pull --rebase`
// conflicted on `docs/overnight/ledger.md`, and the `git add -A` in the SAME command
// swallowed the conflicted file. Three line-anchored markers reached `main`, and
// **nothing in 1,399 test files noticed** — the repo has extensive written guidance
// about this exact trap (CLAUDE.md: *"three traps, each drawn blood"*, with a
// hand-written re-splice recipe) and had never turned any of it into a check. Written
// guidance is not an instrument: it fires only on someone who remembers to read it,
// at the moment they are least likely to.
//
// ⚠ THE ANCHORING IS THE WHOLE DESIGN. An unanchored grep for these strings returns
// hits on the ledger's OWN PROSE describing this incident — that false positive is
// itself recorded in CLAUDE.md, and a guard that reds on the documentation of the bug
// it prevents trains people to delete the documentation. Two rules keep it honest:
//   1. markers must start at a LINE START, which prose quoting them inline does not;
//   2. a file is only conflicted when it has BOTH an opening and a closing marker, so
//      a Markdown setext H1 underline (`=======` on its own line) can never trip it.
//
// ⚠ IT ASSERTS THE COUNT IT INSPECTED. A guard that walks nothing exits clean, and
// this repo has shipped that bug — a staged-only default once inspected zero files on
// a CI checkout and passed.

const ROOT = path.resolve(__dirname, "..")

const OPEN = /^<<<<<<< \S/m
const CLOSE = /^>>>>>>> \S/m

/** Every tracked file git considers text, from git itself — not a hand-kept list. */
function trackedTextFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
  // Binary extensions only; everything else is inspected. An allowlist of what to
  // CHECK would silently shrink as the repo grows — the suppression list is the
  // curated one, and it is about file FORMAT, not about which code is trusted.
  const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|pdf|zip|gz|mp4|webm|wasm)$/i
  return out.filter((f) => !BINARY.test(f))
}

const FILES = trackedTextFiles()

describe("no unresolved conflict markers are committed", () => {
  it("is not vacuous: the walk actually enumerated the repo", () => {
    // Asserts on the WALK, never on a dirty count — the assertion has to stay
    // satisfiable at a population of zero, which is the permanent goal here.
    expect(FILES.length).toBeGreaterThan(500)
    expect(FILES).toContain("docs/overnight/ledger.md")
    expect(FILES).toContain("CLAUDE.md")
  })

  it("guards-the-guard: the detector fires on a real conflict and NOT on prose about one", () => {
    const conflicted = [
      "some text",
      "<<<<<<< Updated upstream",
      "theirs",
      "=======",
      "mine",
      ">>>>>>> Stashed changes",
    ].join("\n")
    expect(OPEN.test(conflicted) && CLOSE.test(conflicted)).toBe(true)

    // The false positive that motivated the anchoring: the ledger's own account of
    // this incident, quoting the markers inline inside a sentence.
    const prose = [
      "On a rebase conflict, do NOT hand-edit the markers — re-splice into",
      "upstream's copy. An unanchored grep for `<<<<<<<` and `>>>>>>>` returned",
      "six hits, all of them this file's own prose.",
    ].join("\n")
    expect(OPEN.test(prose) && CLOSE.test(prose)).toBe(false)

    // A Markdown setext H1 underline is a line of `=` and must never count.
    const setext = "Ledger\n=======\n\nsome body text"
    expect(OPEN.test(setext) && CLOSE.test(setext)).toBe(false)
  })

  it("BAN: no tracked file carries both an opening and a closing conflict marker", () => {
    const bad: string[] = []
    for (const rel of FILES) {
      let src: string
      try {
        src = readFileSync(path.join(ROOT, rel), "utf8")
      } catch {
        continue // unreadable or a broken symlink; not this guard's business
      }
      if (OPEN.test(src) && CLOSE.test(src)) bad.push(rel)
    }
    expect(
      bad.join("\n"),
      "Unresolved merge/rebase conflict markers are committed:\n" +
        bad.join("\n") +
        "\n\nDo NOT hand-edit them. Re-splice your entry into upstream's copy\n" +
        "(`git show :2:<path>`) at the first line-start heading, then re-run the\n" +
        "ledger guards. And never `git add -A` in the same command as a stash pop\n" +
        "or a rebase — stage the file by name.",
    ).toBe("")
  })
})
