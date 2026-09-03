// Rot-guard for the COVERAGE GATES THEMSELVES.
//
// The repo has three coverage ratchets, each a separate vitest config with its
// own thresholds:
//   vitest.config.ts             → lib/** + app/**/route.ts(x) + proxy.ts
//   vitest.components.config.ts  → components/<subtrees> + app/**/*Client.tsx
//   vitest.workers.config.ts     → workers/**            (added 2026-08-15)
//
// ⚠ A COVERAGE GATE IS ONLY A GATE WHILE CI RUNS IT. A config with excellent
// thresholds that no workflow invokes is indistinguishable, from the outside,
// from having no gate at all — and it is WORSE than none, because the file's
// existence reads as active protection to anyone who greps for it. That is the
// same failure this repo has now documented several times from other angles:
// insights-gate-include-completeness (a subtree outside the include), the
// server-page ratchets (a page outside either gate), and the allowlist guard
// that named the wrong `analytics/wallets` page. Each time, the instrument was
// green and silent about the thing it did not reach.
//
// So this asserts the loop is closed: every gate config has an npm script, and
// every npm script is invoked by a job in ci.yml.
//
// ⚠ It deliberately does NOT assert the threshold VALUES. Those move legitimately
// (up as coverage climbs, and down in the one documented case where files left
// the measured set), and pinning them here would mean editing two files for
// every raise — which is exactly the friction that leads people to stop raising.

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "..")

interface Gate {
  config: string
  script: string
  /** What the gate measures, for the failure message. */
  covers: string
}

const GATES: Gate[] = [
  { config: "vitest.config.ts", script: "test:coverage", covers: "lib/** + app/**/route.ts(x) + proxy.ts" },
  {
    config: "vitest.components.config.ts",
    script: "test:coverage:components",
    covers: "components/<subtrees> + app/**/*Client.tsx",
  },
  {
    config: "vitest.workers.config.ts",
    script: "test:coverage:workers",
    covers: "workers/** (Cloudflare ingest + proxies)",
  },
]

describe("coverage gates are wired to CI", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"))
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8")

  it.each(GATES)("$config exists and declares thresholds", (gate) => {
    const p = path.join(ROOT, gate.config)
    expect(existsSync(p), `${gate.config} is missing`).toBe(true)
    const src = readFileSync(p, "utf8")
    expect(src, `${gate.config} must declare coverage thresholds`).toMatch(/thresholds:\s*\{/)
    // A gate whose thresholds are all zero passes unconditionally — the same
    // "reads as protection, provides none" failure this file exists to catch.
    const block = src.slice(src.indexOf("thresholds:"))
    const nums = [...block.matchAll(/(statements|branches|functions|lines):\s*([0-9.]+)/g)].map((m) =>
      Number(m[2])
    )
    expect(nums.length, `${gate.config} must set all four thresholds`).toBeGreaterThanOrEqual(4)
    expect(
      Math.max(...nums.slice(0, 4)),
      `${gate.config} thresholds are all zero — that gate cannot fail`
    ).toBeGreaterThan(0)
  })

  it.each(GATES)("$script is an npm script pointing at $config", (gate) => {
    const cmd: string | undefined = pkg.scripts?.[gate.script]
    expect(cmd, `package.json is missing the "${gate.script}" script`).toBeTruthy()
    expect(cmd, `"${gate.script}" must run coverage`).toContain("--coverage")
    if (gate.config !== "vitest.config.ts") {
      // The default config is implicit; the others must be named explicitly.
      expect(cmd, `"${gate.script}" must point at ${gate.config}`).toContain(gate.config)
    }
  })

  it.each(GATES)("ci.yml runs $script (covering $covers)", (gate) => {
    if (gate.config === "vitest.config.ts") {
      // 2026-09-03: the primary gate is SHARDED. Two matrix jobs run
      // `test:coverage:shard` with the thresholds zeroed (a half-suite coverage
      // number is not a number about the codebase), and a merge job runs
      // `test:coverage:merge`, which applies vitest.config.ts's thresholds to
      // the MERGED coverage. So the ratchet is enforced by the merge script, and
      // that is what must be wired — a plain `npm run test:coverage` match would
      // be satisfied by the shard script's name as a substring.
      const shard: string = pkg.scripts["test:coverage:shard"] ?? ""
      const merge: string = pkg.scripts["test:coverage:merge"] ?? ""
      expect(shard, "shard script must emit a blob").toContain("--reporter=blob")
      expect(shard, "shard script must zero every threshold, or a half suite fails the ratchet").toMatch(
        /thresholds\.lines=0.*thresholds\.functions=0.*thresholds\.branches=0.*thresholds\.statements=0/,
      )
      expect(merge, "merge script must merge the blobs WITH coverage").toContain("--merge-reports")
      expect(merge).toContain("--coverage")
      expect(ci, "no CI job runs the shards").toMatch(/npm run test:coverage:shard -- --shard=/)
      expect(
        ci,
        `No CI job runs "npm run test:coverage:merge", so the ${gate.covers} ratchet is ORPHANED — ` +
          "the shards zero their thresholds by design, and only the merge applies them.",
      ).toContain("npm run test:coverage:merge")
      // The merge must not be reachable without both shards.
      expect(ci).toMatch(/needs: \[changes, unit-tests-shard\]/)
      return
    }
    expect(
      ci,
      `No CI job runs "npm run ${gate.script}", so the ${gate.covers} gate is ORPHANED — ` +
        "it will never fail a build, and its existence reads as protection it is not providing."
    ).toContain(`npm run ${gate.script}`)
  })

  it("every vitest.*.config.ts in the repo is claimed by a gate above", () => {
    // Catches the reverse: a FOURTH config added later without being registered
    // here, which would sit outside this guard by construction — the blind spot
    // this repo keeps re-finding, met one level up.
    const { readdirSync } = require("fs") as typeof import("fs")
    const configs = readdirSync(ROOT).filter(
      (f: string) => /^vitest\..*config\.ts$/.test(f) || f === "vitest.config.ts"
    )
    const claimed = new Set(GATES.map((g) => g.config))
    const unclaimed = configs.filter((c: string) => !claimed.has(c))
    expect(
      unclaimed,
      "A vitest config exists that this guard does not know about. Add it to GATES " +
        "(with its npm script and a ci.yml job), or delete it."
    ).toEqual([])
  })
})
