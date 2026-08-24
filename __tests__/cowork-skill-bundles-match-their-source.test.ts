import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// docs/cowork-skills/ stores every Cowork skill TWICE — as <name>/SKILL.md (what
// a human edits and reviews) and as <name>.skill (the zip that actually gets
// UPLOADED and installed). Until 2026-08-24 nothing compared them, and nothing
// in scripts/, __tests__/ or .github/ referenced docs/cowork-skills/ at all.
//
// ⚠ The guard found a real defect on its FIRST run, before any fixture existed:
// rpc-handoff's bundle was packed 2026-05-30 and still carried the original
// "plain text, NO markdown code fences — copy-pasted from an iPhone" rule, which
// was explicitly RETIRED on 2026-07-25. Uploading it would have reinstalled a
// retired rule — and because the drift included the `description:` line, it
// would also have changed what the skill TRIGGERS on.
//
// ⛔ Scope, stated so this is not read as broader coverage: the copy that
// actually LOADS lives outside the repo. On 2026-08-24 the installed
// rpc-cron-ops was a pre-2026-06-19 export MISSING the post-leak secret-safety
// rule that both the repo file and its bundle carry — drift in the opposite
// direction, which no repo-side guard can see. This covers the direction the
// repo controls.

const GUARD = path.join(process.cwd(), "scripts/check-cowork-skill-bundles.mjs")

function run(root?: string): { code: number; out: string } {
  const args = [GUARD, ...(root ? ["--root", root] : [])]
  try {
    const out = execFileSync("node", args, { encoding: "utf8", stdio: "pipe" })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
  }
}

function fixture(build: (skillsDir: string) => void): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cowork-skill-guard-"))
  const skills = path.join(dir, "docs/cowork-skills")
  mkdirSync(skills, { recursive: true })
  build(skills)
  return dir
}

function writeSkill(skills: string, name: string, source: string, packed: string) {
  mkdirSync(path.join(skills, name), { recursive: true })
  writeFileSync(path.join(skills, name, "SKILL.md"), source)
  const staging = path.join(skills, `.staging-${name}`)
  mkdirSync(staging, { recursive: true })
  writeFileSync(path.join(staging, "SKILL.md"), packed)
  execFileSync("zip", ["-jqX", path.join(skills, `${name}.skill`), path.join(staging, "SKILL.md")])
  rmSync(staging, { recursive: true, force: true })
}

const BODY = "---\nname: x\ndescription: y\n---\n\n# Body\n\n- a rule\n"

// ⚠ The fixture arms below BUILD zip archives, so they need `zip` on PATH.
// ubuntu-latest ships it; Git Bash on Windows does NOT, and on 2026-08-24 their
// `spawnSync zip ENOENT` left `npm test` permanently red on Trevor's box — which
// destroys the property that makes a red run informative there ("a red file now
// MEANS something"). They are gated rather than deleted, and the gate is LOUD:
// a silent skip reads as coverage, which is the failure mode this repo keeps
// hitting. CI is unaffected — `zip` is present, so every arm runs there.
//
// ⛔ This gate is NOT what stopped the destruction. The packer itself now
// preflights `zip` BEFORE `unlinkSync`, because the determinism arm ran
// `scripts/pack-cowork-skill.mjs` against the REAL working tree and its
// delete-then-recreate DELETED the tracked `rpc-handoff.skill` when `zip` was
// missing. Skipping the arm hides the symptom; the preflight fixes the cause.
function hasBin(bin: string): boolean {
  try {
    execFileSync(bin, ["-v"], { stdio: "ignore" })
    return true
  } catch (e) {
    return (e as { code?: string }).code !== "ENOENT"
  }
}
const HAS_ZIP = hasBin("zip")
if (!HAS_ZIP) {
  console.warn(
    "\n⚠ cowork-skill-bundle guard: `zip` is not on PATH, so the 5 FIXTURE arms are " +
      "SKIPPED (the 3 live-tree arms still ran). This is an environment gap on this " +
      "machine, not a passing guard — CI runs all 8. Install zip to close it.\n",
  )
}

describe("Cowork skill bundles match the SKILL.md they were packed from", () => {
  it("passes on the LIVE tree — a ban at population zero, not an allowlist", () => {
    const { code, out } = run()
    expect(out).toMatch(/bundle\(s\) match their SKILL\.md/)
    expect(code).toBe(0)
  })

  it("inspects the REAL population on the live tree, not an empty set", () => {
    // ⚠ Assert the count it inspected. A guard that gates an empty set reads as
    // coverage in every report — this repo has shipped exactly that before.
    const { out } = run()
    const n = Number(out.match(/guard: (\d+) bundle\(s\)/)?.[1] ?? 0)
    const dirs = readdirSync(path.join(process.cwd(), "docs/cowork-skills"), {
      withFileTypes: true,
    }).filter((d) => d.isDirectory()).length
    expect(n).toBe(dirs)
    expect(n).toBeGreaterThanOrEqual(5)
  })

  it.skipIf(!HAS_ZIP)("REDS when a bundle's content drifts from its source — the real 2026-08-24 defect", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      writeSkill(skills, "f", BODY, BODY.replace("- a rule", "- a RETIRED rule"))
    })
    const { code, out } = run(dir)
    expect(out).toMatch(/\bf\b — bundle content differs/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_ZIP)("REDS when a skill has no bundle beside it at all", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      mkdirSync(path.join(skills, "orphan"), { recursive: true })
      writeFileSync(path.join(skills, "orphan/SKILL.md"), BODY)
    })
    const { code, out } = run(dir)
    expect(out).toMatch(/orphan — no orphan\.skill bundle/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_ZIP)("passes when every fixture bundle matches — so the red arms above are not vacuous", () => {
    // NO-CHANGE CONTROL. Without it, a guard that reds unconditionally would
    // satisfy both arms above and look like working detection.
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
    })
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_ZIP)("ignores pure whitespace/CRLF differences — a re-pack that changed nothing must not red", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d"]) writeSkill(skills, n, BODY, BODY)
      writeSkill(skills, "e", BODY, BODY.replace(/\n/g, "\r\n") + "\n\n  \n")
    })
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("FAILS rather than passing when it would inspect nothing", () => {
    const dir = fixture(() => {})
    const { code, out } = run(dir)
    expect(out).toMatch(/INSPECTED NOTHING/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!HAS_ZIP)("the packer is DETERMINISTIC — re-packing unchanged content is a no-op diff", () => {
    // The stale bundle survived from 2026-05-30 to 2026-08-24 partly because a
    // binary diff on every re-pack trains reviewers to skip it.
    const before = execFileSync("md5sum", ["docs/cowork-skills/rpc-handoff.skill"], {
      encoding: "utf8",
    }).split(" ")[0]
    execFileSync("node", ["scripts/pack-cowork-skill.mjs", "rpc-handoff"], { stdio: "ignore" })
    const after = execFileSync("md5sum", ["docs/cowork-skills/rpc-handoff.skill"], {
      encoding: "utf8",
    }).split(" ")[0]
    expect(after).toBe(before)
  })
})
