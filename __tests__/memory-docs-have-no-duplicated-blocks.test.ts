import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

// A scripted insert into docs/reference/routes-and-surfaces.md on 2026-08-25
// (commit 3592f1d6d) split a bullet MID-TOKEN and pasted a 46-line copy of the
// file's own opening — header comment, `## THREE switches…` section and all —
// into the middle of it. The file carried two copies of half its content, and a
// sentence that ended in "then a `^[0-9]+" followed by a document header, for
// TWO DAYS. Every guard in the repo was green the whole time: the link guard
// checks targets, the retired-rule guard checks absences, and neither has any
// opinion about a file containing itself twice.
//
// It was found by eye, which is not a detector. This is the detector.
//
// ⚠ WHY THESE THREE SIGNALS. Each is a fingerprint of a bad splice rather than a
// style preference, and each is a BAN AT ZERO — there is no legitimate reason
// for any of them in a memory doc:
//   1. the "Extracted from CLAUDE.md" header comment appearing more than once —
//      the exact fingerprint of the 08-25 corruption;
//   2. a repeated `## ` heading inside one file — how the SECOND instance was
//      found the same day (claude-md-condensed-originals.md carried the same
//      "Displaced 2026-08-23" section twice, its quote identical after
//      whitespace normalisation);
//   3. a markdown link whose text runs into an HTML comment — the shape a splice
//      leaves when it lands inside a line rather than between two.
//
// ⚠ It walks the TREE, not a curated list, because a curated list cannot see the
// file nobody thought to add — and it asserts the number of files it inspected,
// because a walk that silently matched nothing would pass every case below.
const ROOTS = ["docs/reference", "docs/strategy"]
const HEADER = "<!-- Extracted from CLAUDE.md"

function memoryDocs(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const root of ROOTS) {
    const dir = path.join(process.cwd(), root)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue
      out.push({ file: `${root}/${name}`, text: readFileSync(path.join(dir, name), "utf8") })
    }
  }
  return out
}

describe("memory docs carry no duplicated blocks", () => {
  it("inspects a non-zero population of docs (a walk matching nothing must not pass)", () => {
    const docs = memoryDocs()
    expect(docs.length).toBeGreaterThan(20)
  })

  it("no file contains its own extraction header more than once", () => {
    const offenders = memoryDocs()
      .map(({ file, text }) => ({ file, n: text.split(HEADER).length - 1 }))
      .filter((d) => d.n > 1)
    expect(offenders).toEqual([])
  })

  it("no file repeats an H2 heading", () => {
    const offenders: { file: string; heading: string; times: number }[] = []
    for (const { file, text } of memoryDocs()) {
      const counts = new Map<string, number>()
      for (const line of text.split("\n")) {
        if (!line.startsWith("## ")) continue
        counts.set(line, (counts.get(line) ?? 0) + 1)
      }
      for (const [heading, times] of counts) {
        if (times > 1) offenders.push({ file, heading: heading.slice(0, 80), times })
      }
    }
    expect(offenders).toEqual([])
  })

  it("the extraction header, wherever it appears, starts its own line", () => {
    // The 08-25 seam looked exactly like this: `  \`^[0-9]+<!-- Extracted from…`
    // — a document header fused onto the tail of a sentence.
    //
    // ⚠ NARROWED ON PURPOSE, and the first draft is worth recording: the general
    // form ("no prose before any `<!--` on a line") FALSE-POSITIVED on
    // testing-and-ci.md, which documents the inline `<!-- retired-rule:allow <id>
    // -->` marker in running prose — a marker whose whole design is to sit at the
    // END of a line. A guard that fires on the thing it documents is noise, so
    // this asserts the ONE comment that is structurally a document header and can
    // never legitimately appear mid-line.
    const offenders: { file: string; line: number; text: string }[] = []
    for (const { file, text } of memoryDocs()) {
      text.split("\n").forEach((line, i) => {
        const at = line.indexOf(HEADER)
        if (at > 0) offenders.push({ file, line: i + 1, text: line.slice(0, 90) })
      })
    }
    expect(offenders).toEqual([])
  })
})
