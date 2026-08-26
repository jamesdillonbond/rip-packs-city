import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// A `catch` block must not assert COMPLETENESS.
//
//     } catch {
//       setExhausted(true)      // ⛔ "that was the whole list" — on evidence that the READ FAILED
//     }
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// It has shipped twice in the same component family. `EditionsGridPaginated`
// carried it and was fixed (its source still comments "THIS USED TO
// setExhausted(true)"); `PlayersGridPaginated` — the same pattern two files
// over — kept it until 2026-08-26, silently truncating a team roster. Nobody
// grepped for the second copy, which is this repo's most-repeated lesson:
// **grep for the EXPRESSION, not the file.**
//
// The user-visible defect is the documented paged-read class: a failed page
// removes the Load-more affordance, so a PARTIAL list renders identically to a
// complete one — the same shape as the sitemap that served 24,000 of 27,246
// editions under a 200. Exhaustion is a CLAIM about the upstream; a failure is
// not evidence for it.
//
// ── WHY THE TESTS DID NOT CATCH IT, WHICH IS WHY THIS IS STATIC ────────────
// Both components HAD a test for the error path. Both asserted the Load-more
// button DISAPPEARS — the defect written down as the expected result. Worse,
// after the fix the button's label changes ("Retry"), so the old query is null
// under the fix AND the defect: measured, not argued — re-introducing
// `setExhausted(true)` left `component-EditionsGridPaginated` at 11/11 GREEN.
// A behavioural test could not be trusted here; the source shape can.
//
// ── WHY A BAN AND NOT A RATCHET ────────────────────────────────────────────
// The population is ZERO as of 2026-08-26, so a ban costs nothing and can
// never drift upward unnoticed. There is no legitimate reason to conclude a
// list is complete from a failed read.

const ROOTS = ["app", "components", "lib", "workers"]

/** A catch block that sets a completeness/termination flag. */
const CATCH_COMPLETE =
  /catch\s*(?:\([^)]*\))?\s*\{[^}]{0,240}?\bset(?:Exhausted|Done|Complete|Completed|Finished|AllLoaded|EndReached|HasMore)\s*\(\s*(?:true|false)\s*\)/g

/**
 * A catch that ALSO records the failure is honest and exempt: the failure state
 * dominates the render, and marking the list finished merely stops a pager on a
 * list the reader has already been told is broken. `TeamChecklist` does exactly
 * this and is the reason the exemption exists rather than an allowlist entry.
 *
 * ⚠ The exemption is asserted at the PROPERTY's granularity — "this same catch
 * records a failure" — never by naming a file, so a rename cannot silently
 * widen it.
 */
const ALSO_RECORDS_FAILURE = /\bset\w*(?:Failed|Error|Err)\w*\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(tsx|ts)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(full)
  }
  return out
}

function offendingBlocks(src: string): string[] {
  CATCH_COMPLETE.lastIndex = 0
  return (src.match(CATCH_COMPLETE) ?? []).filter((b) => !ALSO_RECORDS_FAILURE.test(b))
}

function scan() {
  const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).map((p) =>
    // ⚠ `path.relative` yields BACKSLASHES on Windows; normalise so any future
    // path comparison here is platform-independent rather than platform-lucky.
    relative(process.cwd(), p).split(sep).join("/"),
  )
  const offenders: string[] = []
  for (const f of files) {
    const blocks = offendingBlocks(stripComments(readFileSync(join(process.cwd(), f), "utf8")))
    for (const b of blocks) offenders.push(`${f} — ${b.replace(/\s+/g, " ").slice(0, 110)}`)
  }
  return { files, offenders }
}

describe("a catch block never asserts that a list is complete", () => {
  const { files, offenders } = scan()

  it("inspected a real tree — a broken walk must not read as a clean repo", () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some((f) => f.startsWith("components/"))).toBe(true)
  })

  it("SELF-TEST — the detector actually flags the shape it bans", () => {
    // Without this the ban is unfalsifiable: a regex that matches nothing would
    // report a clean repo forever. This is the real defect, verbatim.
    const realDefect = `
      } catch {
        setExhausted(true)
      } finally {
        setLoading(false)
      }`
    expect(offendingBlocks(realDefect)).toHaveLength(1)
  })

  it("SELF-TEST — the exemption is real, and narrow", () => {
    // A catch that records the failure too is honest and must NOT be flagged...
    const honest = `
      } catch {
        setFailed(true); setRows([]); setExhausted(true)
      }`
    expect(offendingBlocks(honest)).toHaveLength(0)
    // ...but the exemption must not swallow the defect when no failure is set.
    const stillBad = `
      } catch {
        setRows([]); setExhausted(true)
      }`
    expect(offendingBlocks(stillBad)).toHaveLength(1)
  })

  it("no catch block concludes a list is complete — a ban at population zero", () => {
    expect(
      offenders,
      `A catch block concluded a list was COMPLETE on evidence that the read FAILED.\n` +
        `That renders a TRUNCATED list identically to a full one. Set a separate\n` +
        `failure flag (see PlayersGridPaginated's \`pageFailed\`), keep the retry\n` +
        `affordance, and leave "exhausted" to mean only what the upstream said:\n\n` +
        offenders.join("\n"),
    ).toEqual([])
  })
})
