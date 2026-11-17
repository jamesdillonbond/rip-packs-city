import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// `scripts/check-memory-doc-links.mjs` guards the pointers the 2026-08-17 restructure
// bet this project's memory architecture on: CLAUDE.md was cut to what a session needs
// before it knows its topic, and the rest moved verbatim into docs/reference/*.md with a
// one-line link left behind. That trade is only sound while the links RESOLVE.
//
// ⚠ THE FAILURE IS INVISIBLE BY SHAPE, WHICH IS WHY IT NEEDS A GUARD. A dead pointer does
// not render as broken — it reads as a detail that was never written, which is precisely
// what CLAUDE.md's own header tells a reader NOT to conclude ("a rule that feels missing is
// in one of those files"). Found 2026-08-22: two links in docs/reference/ pointed at
// repo-root files (`vercel.json`, `vitest.config.ts`) with no `../../` prefix, so both
// resolved to docs/reference/<file> and silently missed.
//
// ⚠ WHAT IS PINNED HERE IS THE PROPERTY, NOT THE SPELLING. These tests assert that a
// broken pointer is DETECTED and that an empty run FAILS — not that any particular message
// is emitted — so a strictly better implementation does not red this suite.

const SCRIPT = path.resolve(__dirname, "../scripts/check-memory-doc-links.mjs")
const REPO = path.resolve(__dirname, "..")

/** Run the guard against a fixture root. Returns {code, out}. Never throws. */
function run(root: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

/** Build a minimal fixture tree: CLAUDE.md + docs/reference/*.md + a repo-root file. */
function fixture(referenceDocs: Record<string, string>, claudeMd = "# root\n"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "memdoclinks-"))
  mkdirSync(path.join(dir, "docs", "reference"), { recursive: true })
  writeFileSync(path.join(dir, "CLAUDE.md"), claudeMd)
  writeFileSync(path.join(dir, "vercel.json"), "{}\n")
  for (const [name, body] of Object.entries(referenceDocs)) {
    writeFileSync(path.join(dir, "docs", "reference", name), body)
  }
  return dir
}

describe("memory-doc link guard — detection", () => {
  it("PASSES when every relative pointer resolves", () => {
    const dir = fixture({
      "a.md": "see [b](b.md) and [root config](../../vercel.json)\n",
      "b.md": "back to [a](a.md)\n",
    })
    const { code } = run(dir)
    expect(code).toBe(0)
  })

  it("FAILS on the exact bug it was written for — a root-file link missing ../../", () => {
    // This is the 2026-08-22 defect verbatim: from docs/reference/, `vercel.json`
    // resolves to docs/reference/vercel.json, which does not exist.
    const dir = fixture({ "a.md": "crons live in [vercel.json](vercel.json)\n" })
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out).toContain("vercel.json")
  })

  it("FAILS on a dead pointer between two reference docs", () => {
    const dir = fixture({ "a.md": "moved to [gone](does-not-exist.md)\n" })
    expect(run(dir).code).toBe(1)
  })

  it("FAILS on a dead pointer out of CLAUDE.md itself", () => {
    const dir = fixture(
      { "a.md": "fine\n" },
      "detail lives in [reference](docs/reference/missing.md)\n"
    )
    expect(run(dir).code).toBe(1)
  })
})

describe("memory-doc link guard — must not red on correct code", () => {
  it("ignores external URLs, mailto and bare anchors", () => {
    const dir = fixture({
      "a.md":
        "[site](https://www.rippackscity.com) [x](http://e.com) " +
        "[mail](mailto:a@b.com) [anchor](#a-heading) [ok](b.md)\n",
      "b.md": "hi\n",
    })
    expect(run(dir).code).toBe(0)
  })

  // ⚠ CODE SPANS ARE NOT POINTERS, and treating them as such reddened `main` on
  // 2026-09-02. A line of prose in tooling-gotchas.md quoting a Postgres regex —
  // `count(*) FILTER (WHERE command ~ '[?&](key|token|secret)=')` — contains the
  // byte sequence `](`, so the link regex read it as a pointer to the file
  // "key|token|secret" and the guard failed a doc that has no pointer in it.
  //
  // The claim being pinned is NARROW: markdown does not render a link inside
  // backticks, so a real pointer is never written there. Both directions are
  // asserted, because ignoring code spans is only safe if a dead link OUTSIDE
  // them on the same line is still caught.
  it("ignores a link-shaped fragment inside an inline code span", () => {
    const dir = fixture({
      "a.md":
        "the probe is `count(*) FILTER (WHERE command ~ '[?&](key|token|secret)=')` " +
        "and the detail is in [b](b.md)\n",
      "b.md": "hi\n",
    })
    expect(run(dir).code).toBe(0)
  })

  it("ignores link-shaped text inside a fenced code block", () => {
    const dir = fixture({
      "a.md": "```sql\nSELECT 1 WHERE x ~ '[?&](nope.md)'\n```\n\nsee [b](b.md)\n",
      "b.md": "hi\n",
    })
    expect(run(dir).code).toBe(0)
  })

  it("STILL FAILS on a dead pointer outside the backticks on the same line", () => {
    // The positive control for the two above: stripping code spans must not be a
    // way to stop detecting anything.
    const dir = fixture({
      "a.md": "`[x](in-code.md)` but also [really gone](does-not-exist.md)\n",
    })
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out).toContain("does-not-exist.md")
    // …and the one inside the backticks is NOT reported, or the strip did nothing.
    expect(out).not.toContain("in-code.md")
  })

  it("resolves a link that carries a #fragment", () => {
    const dir = fixture({
      "a.md": "[b, at a heading](b.md#some-heading)\n",
      "b.md": "## some heading\n",
    })
    expect(run(dir).code).toBe(0)
  })
})

describe("memory-doc link guard — it cannot pass by inspecting nothing", () => {
  // ⚠ This is the check-tree-corruption.mjs lesson pinned. That guard shipped as pure
  // theatre: its default mode inspected NOTHING on a CI checkout and still exited 0, so it
  // read as coverage in every grep, review and report. A guard must fail, not pass, when
  // its population is empty for the wrong reason.
  it("FAILS rather than passes when the root contains no memory docs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "memdoclinks-empty-"))
    const { code, out } = run(dir)
    expect(code).toBe(1)
    expect(out.toLowerCase()).toContain("nothing")
  })

  it("FAILS when the docs exist but contain no relative links at all", () => {
    const dir = fixture({ "a.md": "prose with no links whatsoever\n" }, "# root, no links\n")
    expect(run(dir).code).toBe(1)
  })
})

describe("memory-doc link guard — it is actually RUN", () => {
  // ⚠ CLAUDE.md: ask what RUNS a guard, not only whether it passes. An unwired guard and a
  // green build look identical. check-tree-corruption.mjs sat with no CI job at all.
  it("is wired into the ci.yml workflow as a blocking step", () => {
    const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8")
    expect(ci).toContain("scripts/check-memory-doc-links.mjs")
  })

  it("the LIVE memory docs are clean — this is a ban at population zero", () => {
    // No --root: exercises the real gated set and the live-only population floors.
    let code = 0
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e: any) {
      code = e.status ?? 1
    }
    expect(code).toBe(0)
  })
})
