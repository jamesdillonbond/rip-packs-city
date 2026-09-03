import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// ⚠ WHY (2026-09-03, CI audit L2). A `uses: owner/action@v4` line runs whatever
// commit the action's maintainer points `v4` at TODAY. That is the supply-chain
// shape behind the 2025 tj-actions compromise: a moving tag re-pointed at a
// payload, executed with every secret the calling job holds. Here the calling
// jobs hold INGEST_SECRET_TOKEN and the Supabase service-role key.
//
// Every third-party action is therefore pinned to a 40-hex commit sha, with the
// tag it was resolved from as a trailing `# vX.Y.Z` comment (the form Dependabot
// reads when a security advisory needs the pin moved). This is a BAN AT ZERO:
// the population of floating refs was brought to 0 in the commit that added this
// test (57 references, six distinct actions), and any floating ref is a failure.
//
// Local composites (`uses: ./.github/actions/...`) are this repo's own code and
// are exempt by construction — they have no tag to float.
//
// ⚠ Non-vacuity: the walk must find a non-trivial number of `uses:` lines across
// BOTH roots (workflows and composite actions), or a broken walk would pass.

const ROOT = process.cwd()
const WORKFLOWS = join(ROOT, ".github", "workflows")
const ACTIONS = join(ROOT, ".github", "actions")

const files = [
  ...readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml")).map((f) => join(WORKFLOWS, f)),
  ...readdirSync(ACTIONS).map((d) => join(ACTIONS, d, "action.yml")),
]

type Use = { file: string; line: number; ref: string }
const uses: Use[] = files.flatMap((file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => /^\s*-?\s*uses:\s/.test(text))
    .map(({ text, i }) => ({ file: file.replace(ROOT + "/", ""), line: i + 1, ref: text.replace(/^\s*-?\s*uses:\s*/, "").trim() })),
)

const external = uses.filter((u) => !u.ref.startsWith("./"))
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+){0,2}\s*$/

describe("every third-party GitHub Action is pinned to a commit sha", () => {
  it("walked both roots and found a non-trivial number of uses: lines", () => {
    expect(files.length).toBeGreaterThan(20)
    expect(uses.length).toBeGreaterThan(40)
    expect(external.length).toBeGreaterThan(30)
    // The second root must be IN the walk. Today's composites carry no `uses:`
    // of their own (they are pure `run:` steps), so the assertion is on the file
    // list, not on findings — a composite that later `uses:` something is then
    // inside the ban the day it lands.
    expect(files.filter((f) => f.includes("/.github/actions/")).length).toBeGreaterThanOrEqual(2)
  })

  it("POSITIVE CONTROL — a floating tag is rejected, a sha with a version comment is accepted", () => {
    expect(PINNED.test("actions/checkout@v4")).toBe(false)
    expect(PINNED.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262")).toBe(false) // sha without the comment
    expect(PINNED.test("actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0")).toBe(true)
    expect(PINNED.test("denoland/setup-deno@22d081ff2d3a40755e97629de92e3bcbfa7cf2ed # v2.0.5")).toBe(true)
  })

  it("BAN AT ZERO — no floating ref anywhere under .github", () => {
    const floating = external.filter((u) => !PINNED.test(u.ref))
    expect(
      floating.map((u) => `${u.file}:${u.line}  ${u.ref}`),
      "Pin to the commit sha of the tag you mean, with the tag as a trailing comment:\n" +
        "  uses: owner/action@<40-hex sha> # vX.Y.Z\n" +
        "Resolve it with `git ls-remote --tags https://github.com/owner/action.git` (the peeled\n" +
        "`^{}` sha for an annotated tag). A moving tag executes whatever it points at today.",
    ).toEqual([])
  })
})
