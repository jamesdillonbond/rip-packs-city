import { describe, it, expect } from "vitest"
import { zipOneFile, zipFiles } from "../scripts/lib/zip-one-file.mjs"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
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
  // Built with the SAME writer the packer uses (scripts/lib/zip-one-file.mjs),
  // so a fixture bundle cannot differ in shape from a real one — and so these
  // arms no longer need `zip` on PATH. `packed` is deliberately allowed to
  // differ from `source`: that is how the drift arms are constructed.
  writeFileSync(path.join(skills, `${name}.skill`), zipOneFile("SKILL.md", packed))
}

const BODY = "---\nname: x\ndescription: y\n---\n\n# Body\n\n- a rule\n"

// Digests of the REAL bundles, captured at import BEFORE any arm runs, so the
// "suite does not mutate the working tree" arm compares against pre-test truth
// rather than against whatever an earlier arm may have written.
function realBundleDigests(): Record<string, string> {
  const dir = path.join(process.cwd(), "docs/cowork-skills")
  const out: Record<string, string> = {}
  for (const n of readdirSync(dir).sort()) {
    if (!n.endsWith(".skill")) continue
    out[n] = createHash("sha256").update(readFileSync(path.join(dir, n))).digest("hex")
  }
  return out
}
const BUNDLES_AT_IMPORT = realBundleDigests()

// ⭐ THESE ARMS NO LONGER NEED `zip` ON PATH, AND THAT CLOSED A REAL GAP.
// Until 2026-09-18 the five fixture arms were `skipIf(!HAS_ZIP)` and the file
// warned, correctly, that on Git Bash for Windows this was *"an environment gap
// on this machine, not a passing guard"* — 4 of 9 arms ran on Trevor's box while
// CI ran all 9. The fixtures now build through scripts/lib/zip-one-file.mjs, the
// same pure-Node writer the packer falls back to, so every arm runs everywhere.
//
// ⛔ HISTORY WORTH KEEPING: the gate was never what stopped the destruction. The
// determinism arm once ran the packer against the REAL working tree and its
// delete-then-recreate DELETED the tracked `rpc-handoff.skill` when `zip` was
// missing. What fixes that is the packer building its buffer BEFORE writing, plus
// the "does NOT mutate the real docs/cowork-skills/" arm at the bottom of this
// file — not skipping the arm.

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

  it("REDS when a bundle's content drifts from its source — the real 2026-08-24 defect", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      writeSkill(skills, "f", BODY, BODY.replace("- a rule", "- a RETIRED rule"))
    })
    const { code, out } = run(dir)
    expect(out).toMatch(/\bf\b — bundle content differs/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("REDS when a skill has no bundle beside it at all", () => {
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

  it("passes when every fixture bundle matches — so the red arms above are not vacuous", () => {
    // NO-CHANGE CONTROL. Without it, a guard that reds unconditionally would
    // satisfy both arms above and look like working detection.
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
    })
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("ignores pure whitespace/CRLF differences — a re-pack that changed nothing must not red", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d"]) writeSkill(skills, n, BODY, BODY)
      writeSkill(skills, "e", BODY, BODY.replace(/\n/g, "\r\n") + "\n\n  \n")
    })
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  // 2026-09-24: references/ travel with the skill. rpc-surface-qa's SKILL.md sends the
  // reader to references/surface-checklist.md; its installed copy had the file, the repo
  // bundle did not, so re-saving the bundle would have removed it. Three arms: missing,
  // drifted, and the matching control.
  function writeSkillWithRef(skills: string, name: string, refSource: string, refPacked: string | null) {
    mkdirSync(path.join(skills, name, "references"), { recursive: true })
    writeFileSync(path.join(skills, name, "SKILL.md"), BODY)
    writeFileSync(path.join(skills, name, "references/checklist.md"), refSource)
    const entries = [{ name: "SKILL.md", content: BODY }]
    if (refPacked !== null) entries.push({ name: "references/checklist.md", content: refPacked })
    writeFileSync(path.join(skills, `${name}.skill`), zipFiles(entries))
  }

  it("REDS when a skill's references/ file is missing from its bundle", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      writeSkillWithRef(skills, "g", "# checklist\n", null)
    })
    const { code, out } = run(dir)
    expect(out).toMatch(/\bg\b — bundle lacks references\/checklist\.md/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("REDS when a bundled references/ file drifts from its source", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      writeSkillWithRef(skills, "g", "# checklist\n- current\n", "# checklist\n- RETIRED\n")
    })
    const { code, out } = run(dir)
    expect(out).toMatch(/\bg\b — bundle's references\/checklist\.md differs/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("passes when the bundle carries the same references/ file — the two arms above are not vacuous", () => {
    const dir = fixture((skills) => {
      for (const n of ["a", "b", "c", "d", "e"]) writeSkill(skills, n, BODY, BODY)
      writeSkillWithRef(skills, "g", "# checklist\n", "# checklist\r\n\n")
    })
    expect(run(dir).code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it("the packer carries references/ and a single-entry archive is byte-identical to the old writer", () => {
    expect(zipOneFile("SKILL.md", BODY).equals(zipFiles([{ name: "SKILL.md", content: BODY }]))).toBe(true)
    const root = mkdtempSync(path.join(tmpdir(), "cowork-skill-refs-"))
    const skills = path.join(root, "docs/cowork-skills")
    mkdirSync(path.join(skills, "refs-fixture/references"), { recursive: true })
    writeFileSync(path.join(skills, "refs-fixture/SKILL.md"), BODY)
    writeFileSync(path.join(skills, "refs-fixture/references/b.md"), "b\n")
    writeFileSync(path.join(skills, "refs-fixture/references/a.md"), "a\n")
    execFileSync("node", [path.join(process.cwd(), "scripts/pack-cowork-skill.mjs"), "refs-fixture"], {
      cwd: root,
      stdio: "ignore",
    })
    const bundle = path.join(skills, "refs-fixture.skill")
    const listing = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" }).trim().split("\n")
    expect(listing).toEqual(["SKILL.md", "references/a.md", "references/b.md"])
    expect(execFileSync("unzip", ["-p", bundle, "references/b.md"], { encoding: "utf8" })).toBe("b\n")
    rmSync(root, { recursive: true, force: true })
  })

  it("FAILS rather than passing when it would inspect nothing", () => {
    const dir = fixture(() => {})
    const { code, out } = run(dir)
    expect(out).toMatch(/INSPECTED NOTHING/)
    expect(code).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it("the packer is DETERMINISTIC — re-packing unchanged content is a no-op diff", () => {
    // The stale bundle survived from 2026-05-30 to 2026-08-24 partly because a
    // binary diff on every re-pack trains reviewers to skip it.
    //
    // 🚨 THIS ARM USED TO RUN THE PACKER AGAINST THE REAL WORKING TREE, AND THAT
    // MADE THE GUARD SELF-DEFEATING. Measured 2026-08-24 by planting drift in
    // docs/cowork-skills/rpc-handoff/SKILL.md: the checker went RED (correct),
    // then `vitest run` on THIS FILE rewrote the tracked bundle (md5 e76c6b55 ->
    // 200b5bd6) and the checker went GREEN — `npm test` had LAUNDERED real drift
    // into a passing guard and left an unexplained binary diff behind. A guard
    // that repairs the condition it exists to report cannot report it.
    //
    // The property is still worth asserting, so it is asserted in a TEMP tree.
    // Nothing under docs/cowork-skills/ is touched.
    const root = mkdtempSync(path.join(tmpdir(), "cowork-skill-pack-"))
    const skills = path.join(root, "docs/cowork-skills")
    mkdirSync(path.join(skills, "determinism-fixture"), { recursive: true })
    writeFileSync(path.join(skills, "determinism-fixture/SKILL.md"), BODY)

    const pack = () =>
      execFileSync("node", [path.join(process.cwd(), "scripts/pack-cowork-skill.mjs"), "determinism-fixture"], {
        cwd: root,
        stdio: "ignore",
      })
    pack()
    const first = readFileSync(path.join(skills, "determinism-fixture.skill"))
    pack()
    const second = readFileSync(path.join(skills, "determinism-fixture.skill"))

    expect(second.equals(first)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("does NOT mutate the real docs/cowork-skills/ — a guard that repairs drift cannot report it", () => {
    // Regression arm for the defect above, and the reason it is phrased as a
    // property of the SUITE rather than of one test: any future arm that packs
    // against the live tree reintroduces the laundering, and this catches it
    // wherever it is added. BUNDLES_AT_IMPORT is snapshotted before any arm runs.
    const now = realBundleDigests()
    expect(now).toEqual(BUNDLES_AT_IMPORT)
    expect(Object.keys(now).length).toBeGreaterThanOrEqual(5)
  })
})
