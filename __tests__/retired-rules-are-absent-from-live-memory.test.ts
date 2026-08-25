import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Over 2026-08-24 a memory refresh corrected six facts. EVERY ONE was wrong on
// more than one surface, and two were still being found AFTER the pass that
// "fixed" them:
//
//   * `.limit(10000)` was corrected in RPC_DESIGN_SYSTEM.md §5 and left intact in
//     the §0 CHECKLIST of the SAME FILE — the section headed "run through this on
//     every edit". A file contradicting itself.
//   * the retired iPhone-copy-paste handoff rule was corrected in §10 and in the
//     rpc-handoff skill on 2026-07-25 and was STILL in CLAUDE.md — the
//     highest-authority memory file — on 2026-08-24.
//
// Nothing decayed. The corrections never PROPAGATED. CLAUDE.md's own rule is
// "grep for the EXPRESSION, not the file"; this guard is that rule, executable.
//
// ⛔ Frozen history (docs/sessions, docs/archive, docs/overnight) is excluded on
// a stated POLICY — recording retired text is what a ledger is FOR, and a
// tree-wide ban would be permanently red, which this repo already knows reads
// identically to a broken instrument.

const GUARD = path.join(process.cwd(), "scripts/check-retired-rules.mjs")

function run(root?: string, minFiles?: number): { code: number; out: string } {
  const args = [
    GUARD,
    ...(root ? ["--root", root] : []),
    ...(minFiles !== undefined ? ["--min-files", String(minFiles)] : []),
  ]
  try {
    return { code: 0, out: execFileSync("node", args, { encoding: "utf8", stdio: "pipe" }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
  }
}

// A fixture root needs >= 15 files to clear the guard's live-population floor,
// so the red arms below fail for the RIGHT reason rather than on the floor.
function fixture(extra: (refs: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "retired-rules-"))
  writeFileSync(path.join(dir, "CLAUDE.md"), "# memory\n\n- a current rule\n")
  writeFileSync(path.join(dir, "RPC_DESIGN_SYSTEM.md"), "# design\n\n- another current rule\n")
  const refs = path.join(dir, "docs/reference")
  mkdirSync(refs, { recursive: true })
  for (let i = 0; i < 20; i++) writeFileSync(path.join(refs, `r${i}.md`), "# ref\n\n- fine\n")
  extra(refs)
  return dir
}

describe("retired rules are absent from every live memory surface", () => {
  it("passes on the LIVE tree — a ban at population zero", () => {
    const { code, out } = run()
    expect(out).toMatch(/retired rule\(s\) absent from \d+ live memory surface\(s\)/)
    expect(code).toBe(0)
  })

  it("REPORTS the population it inspected, so an empty scan cannot read as coverage", () => {
    const { out } = run()
    const files = Number(out.match(/absent from (\d+) live memory/)?.[1] ?? 0)
    const lines = Number(out.match(/\((\d+) lines/)?.[1] ?? 0)
    expect(files).toBeGreaterThanOrEqual(15)
    expect(lines).toBeGreaterThan(1000)
  })

  it("REDS on `.limit(10000)` — the rule that was corrected in §5 and left in §0 of the same file", () => {
    const dir = fixture((refs) =>
      writeFileSync(path.join(refs, "bad.md"), "- Reading >1000 rows: explicit `.limit(10000)` or RPC\n"),
    )
    const { code, out } = run(dir)
    expect(out).toMatch(/limit-10000-lifts-the-postgrest-cap/)
    expect(out).toMatch(/bad\.md:1/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("REDS on the retired iPhone handoff rule — the one that outlived its correction by a month", () => {
    const dir = fixture((refs) =>
      writeFileSync(path.join(refs, "bad.md"), "- prompts: plain text, no code blocks (iPhone copy-paste)\n"),
    )
    const { code, out } = run(dir)
    expect(out).toMatch(/handoffs-are-iphone-pasteable/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("REDS on 'log it in CLAUDE.md Recent sessions' — appending there can blow the memory ceiling", () => {
    const dir = fixture((refs) =>
      writeFileSync(path.join(refs, "bad.md"), "19. **Log it** in `CLAUDE.md` Recent sessions + the ledger.\n"),
    )
    const { code, out } = run(dir)
    expect(out).toMatch(/log-sessions-in-claude-md/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("passes on a clean fixture — so the red arms above are not vacuous", () => {
    // NO-CHANGE CONTROL. A guard that reds unconditionally satisfies every red
    // arm above and looks like working detection.
    const dir = fixture(() => {})
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("a doc may QUOTE a retired rule to warn about it, with an explicit marker", () => {
    const dir = fixture((refs) =>
      writeFileSync(
        path.join(refs, "warn.md"),
        "<!-- retired-rule:allow limit-10000-lifts-the-postgrest-cap -->\n- ⛔ NOT `.limit(10000)` — it is CLAMPED.\n",
      ),
    )
    const { code, out } = run(dir)
    expect(out).toMatch(/1 documented quote/)
    expect(code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("a marker suppresses ONLY the adjacent line — it cannot silence the rest of a file", () => {
    // The suppression must be as narrow as the thing it excuses. A wider
    // lookback would let one marker launder every later violation in the file.
    const dir = fixture((refs) =>
      writeFileSync(
        path.join(refs, "warn.md"),
        "<!-- retired-rule:allow limit-10000-lifts-the-postgrest-cap -->\n" +
          "- ⛔ NOT `.limit(10000)`.\n\n\n- and here we quietly say use `.limit(10000)` again\n",
      ),
    )
    const { code, out } = run(dir)
    expect(out).toMatch(/warn\.md:5/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("a marker for a DIFFERENT rule does not suppress this one", () => {
    const dir = fixture((refs) =>
      writeFileSync(
        path.join(refs, "warn.md"),
        "<!-- retired-rule:allow handoffs-are-iphone-pasteable -->\n- use `.limit(10000)`\n",
      ),
    )
    expect(run(dir).code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("FAILS rather than passing when it would inspect nothing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "retired-rules-empty-"))
    const { code, out } = run(dir)
    expect(out).toMatch(/INSPECTED NOTHING/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("FAILS on a population below its floor rather than reporting a pass", () => {
    // The floor exists because a guard run from the wrong directory finds two
    // files, reports "absent", and reads as coverage.
    //
    // ⚠ This arm needs `--min-files` because the LIVE floor is skipped under
    // `--root` (a fixture is deliberately small) — which left the floor's own
    // logic untestable, and an untested watcher is indistinguishable from a
    // broken one. The live default is unchanged and is asserted below.
    const dir = mkdtempSync(path.join(tmpdir(), "retired-rules-thin-"))
    writeFileSync(path.join(dir, "CLAUDE.md"), "# memory\n")
    const { code, out } = run(dir, 15)
    expect(out).toMatch(/below the 15 floor/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("the LIVE run uses the 15-file floor, so --min-files cannot weaken production", () => {
    // Without this, --min-files would be a hole: a caller could pass 0 and the
    // floor would be gone. On the live tree the flag is ignored by construction.
    const dir = fixture(() => {})
    expect(run(dir, 0).code).toBe(0) // fixture may opt out
    expect(run().code).toBe(0) // live passes on its own 15 floor
    const src = readFileSync(path.join(process.cwd(), "scripts/check-retired-rules.mjs"), "utf8")
    expect(src).toMatch(/IS_LIVE\s*\?\s*LIVE_MIN_FILES/)
    rmSync(dir, { recursive: true, force: true })
  })
})
