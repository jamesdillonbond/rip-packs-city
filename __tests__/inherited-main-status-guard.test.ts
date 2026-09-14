import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  SHARD_JOB_MARKER,
  ranFullSuite,
  decideInheritedStatus,
  inheritedExitCode,
  renderVerdict,
} from "@/scripts/check-last-code-ci-on-main.mjs"

// A CHECK THAT DID NOT RUN IS INDISTINGUISHABLE FROM A CHECK THAT PASSED.
//
// `unit-tests-shard` is gated on `code == 'true'`, so a docs-only push renders a
// green check that means "the docs guards passed" and NOT "main is green". On
// 2026-09-13 that difference hid a red `main` for three consecutive pushes and
// ~9 hours; it surfaced only because the next code push inherited it.
//
// The guard under test reports the last COMPLETED full-suite run on main during
// a docs-only push. Its fail-open (verdict=unknown -> exit 0) is deliberate —
// reddening every docs push over missing run history would be worse than
// useless — which puts all the weight on ONE failure mode: the marker drifting
// away from the job name ci.yml actually produces would turn this guard into a
// permanent no-op that still prints a reassuring line. That is what the first
// test below pins, against ci.yml itself rather than against a copy of the string.

const ROOT = join(__dirname, "..")
const CI_YML = join(ROOT, ".github/workflows/ci.yml")

describe("the shard-job marker still matches the job ci.yml produces", () => {
  it("NOT VACUOUS: expands ci.yml's matrix name and matches it", () => {
    const yml = readFileSync(CI_YML, "utf8")

    // The `name:` of the job whose key is `unit-tests-shard`.
    const block = yml.split(/^  unit-tests-shard:$/m)[1]
    expect(block, "ci.yml must still define a `unit-tests-shard` job").toBeTruthy()
    const nameLine = block.split("\n").find((l) => /^\s{4}name:/.test(l))
    expect(nameLine, "unit-tests-shard must still carry a `name:`").toBeTruthy()

    const template = nameLine!.replace(/^\s*name:\s*/, "").trim()
    // Expand the matrix expression the way Actions does for shard 1 and 2.
    const expanded = [1, 2].map((s) =>
      template.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, String(s)),
    )

    for (const jobName of expanded) {
      expect(
        jobName.startsWith(SHARD_JOB_MARKER),
        `SHARD_JOB_MARKER ${JSON.stringify(SHARD_JOB_MARKER)} no longer prefixes ` +
          `the job ci.yml produces (${JSON.stringify(jobName)}). Renaming the shard job ` +
          `without updating the marker makes the inherited-status guard a silent no-op.`,
      ).toBe(true)
    }
    // And the detector agrees on the real names — when those jobs actually ran.
    expect(ranFullSuite(expanded.map((name) => ({ name, conclusion: "success" })))).toBe(true)
  })

  it("does not mistake a docs-only run's job list for a full suite", () => {
    // The jobs a docs-only push actually runs (CI #5477–#5479).
    expect(
      ranFullSuite(
        [
          "What changed",
          "Memory-doc links",
          "Ledger no-clobber guard",
          "Register integrity guard",
          "Inbox no-clobber guard",
          "Tree corruption (NUL / truncation)",
          "Docs-guard tests (docs-only pushes)",
        ].map((name) => ({ name, conclusion: "success" })),
      ),
    ).toBe(false)
  })

  // 🚨 THE ONE THAT WAS WRONG IN PRODUCTION.
  //
  // The Actions jobs endpoint returns SKIPPED jobs with their real names, so a
  // docs-only run — which skips `unit-tests-shard` by design — still lists a job
  // called "Unit tests (vitest) — shard 1/2". Matching the NAME therefore proved
  // nothing, and this guard's own published summary said so: CI #5503 (docs-only)
  // reported "last full-suite run: CI #5502 · 673fdc9 · success", and 673fdc9 is
  // docs-only. The guard was reporting the last run OF ANY KIND behind a green
  // banner — a no-op that reads as coverage, which is the defect it exists to
  // prevent, one level deeper. The documented risk was MARKER DRIFT; the marker
  // matched perfectly. Whether the job EXECUTED was always the question.
  it("🚨 a SKIPPED shard job is not a shard job that ran (the 2026-09-14 defect)", () => {
    const docsOnlyRun = [
      { name: "What changed", conclusion: "success" },
      { name: "Docs-guard tests (docs-only pushes)", conclusion: "success" },
      { name: "Inherited main status (docs-only pushes)", conclusion: "success" },
      { name: "TypeScript", conclusion: "skipped" },
      { name: "Unit tests (vitest) — shard 1/2", conclusion: "skipped" },
      { name: "Unit tests (vitest) — shard 2/2", conclusion: "skipped" },
    ]
    expect(ranFullSuite(docsOnlyRun)).toBe(false)

    // The control: the same list with the shards actually run.
    const codeRun = docsOnlyRun.map((j) =>
      j.name.startsWith("Unit tests (vitest) — shard") ? { ...j, conclusion: "success" } : j,
    )
    expect(ranFullSuite(codeRun)).toBe(true)

    // A shard that FAILED still ran — that is precisely the run we must report.
    expect(ranFullSuite([{ name: "Unit tests (vitest) — shard 2/2", conclusion: "failure" }])).toBe(true)

    // A null conclusion is not evidence of execution either.
    expect(ranFullSuite([{ name: "Unit tests (vitest) — shard 1/2", conclusion: null }])).toBe(false)
    expect(ranFullSuite([{ name: "Unit tests (vitest) — shard 1/2" }])).toBe(false)
  })
})

// ── The real 2026-09-13 sequence, replayed ──────────────────────────────────
// Newest-first, exactly as the API returns it.
const RUN = (
  runNumber: number,
  headSha: string,
  conclusion: string | null,
  full: boolean,
  status = "completed",
) => ({
  id: 1000 + runNumber,
  runNumber,
  status,
  conclusion,
  headSha,
  displayTitle: `#${runNumber}`,
  htmlUrl: `https://example.invalid/${runNumber}`,
  ranFullSuite: full,
})

describe("it would have caught the 2026-09-13 masking", () => {
  it("reds each of the three docs-only pushes that followed the red", () => {
    // What the guard would have seen standing on #5477, #5478 and #5479.
    for (const runsBefore of [
      [RUN(5476, "3840baf", "failure", true)],
      [RUN(5477, "8940f14", "success", false), RUN(5476, "3840baf", "failure", true)],
      [
        RUN(5478, "e6a5047", "success", false),
        RUN(5477, "8940f14", "success", false),
        RUN(5476, "3840baf", "failure", true),
      ],
    ]) {
      const r = decideInheritedStatus(runsBefore)
      expect(r.verdict).toBe("red")
      expect(r.run?.runNumber).toBe(5476)
      expect(inheritedExitCode(r.verdict)).toBe(1)
      // The message must blame the right commit, not the docs push.
      expect(renderVerdict(r)).toContain("3840baf")
    }
  })

  it("goes green once the fix lands, and ignores docs runs in between", () => {
    const r = decideInheritedStatus([
      RUN(5482, "af9796c", "success", false), // docs push after the fix
      RUN(5481, "4da64b9", "success", true), // the fix
      RUN(5480, "eada52c", "failure", true),
      RUN(5476, "3840baf", "failure", true),
    ])
    expect(r.verdict).toBe("green")
    expect(r.run?.runNumber).toBe(5481)
    expect(inheritedExitCode(r.verdict)).toBe(0)
  })
})

describe("the edges that decide whether this is safe to gate a push on", () => {
  it("NEVER reads its own run", () => {
    const runs = [RUN(5490, "deadbee", "failure", true), RUN(5481, "4da64b9", "success", true)]
    // ⚠ a STRING, because that is what the CURRENT_RUN_ID env var actually gives.
    const r = decideInheritedStatus(runs, { currentRunId: String(1000 + 5490) })
    expect(r.verdict).toBe("green")
    expect(r.run?.runNumber).toBe(5481)
  })

  it("ignores an IN-PROGRESS full-suite run and reports the last completed one", () => {
    const r = decideInheritedStatus([
      RUN(5491, "aaaaaaa", null, true, "in_progress"),
      RUN(5481, "4da64b9", "success", true),
    ])
    expect(r.verdict).toBe("green")
    expect(r.run?.runNumber).toBe(5481)
  })

  it("reds on a cancelled or timed-out full-suite run, not only on `failure`", () => {
    for (const c of ["cancelled", "timed_out", "startup_failure", "action_required"]) {
      expect(decideInheritedStatus([RUN(5492, "bbbbbbb", c, true)]).verdict).toBe("red")
    }
  })

  it("fails OPEN, loudly, when no full-suite run is in the window", () => {
    const r = decideInheritedStatus([RUN(5479, "c3678d3", "success", false)])
    expect(r.verdict).toBe("unknown")
    expect(inheritedExitCode(r.verdict)).toBe(0)
    expect(renderVerdict(r)).toContain("nothing here says main is green")
  })

  it("an empty history is `unknown`, never `green`", () => {
    const r = decideInheritedStatus([])
    expect(r.verdict).toBe("unknown")
    expect(renderVerdict(r)).not.toContain("✅")
  })
})

// ── The HTTP shell, against a real local server ─────────────────────────────
// The fixtures above pin the DECISION. They cannot see the walk: whether it
// stops at the first full-suite run (the jobs endpoint is one request per run,
// so losing the break costs 15 requests on every docs push and fails nothing),
// whether it skips its own run before spending a request on it, or whether a
// non-2xx becomes an ApiError rather than a silent empty list.

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { fetchCandidates, ApiError } from "@/scripts/check-last-code-ci-on-main.mjs"

const SHARD = { name: "Unit tests (vitest) — shard 1/2", conclusion: "success" }
const SHARD_SKIPPED = { name: "Unit tests (vitest) — shard 1/2", conclusion: "skipped" }
const DOCS = { name: "Docs-guard tests (docs-only pushes)", conclusion: "success" }

async function withServer(
  handler: (url: string, res: import("node:http").ServerResponse) => void,
  run: (base: string) => Promise<void>,
) {
  const server = createServer((req, res) => handler(req.url ?? "", res))
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const { port } = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

const json = (res: import("node:http").ServerResponse, body: unknown, code = 200) => {
  res.writeHead(code, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

describe("the walk itself", () => {
  it("stops at the newest full-suite run instead of resolving every run", async () => {
    const jobCalls: string[] = []
    await withServer(
      (url, res) => {
        if (url.includes("/workflows/ci.yml/runs")) {
          return json(res, {
            workflow_runs: [
              { id: 3, run_number: 5479, status: "completed", conclusion: "success", head_sha: "c3678d3", display_title: "docs", html_url: "u3" },
              { id: 2, run_number: 5476, status: "completed", conclusion: "failure", head_sha: "3840baf", display_title: "code", html_url: "u2" },
              { id: 1, run_number: 5451, status: "completed", conclusion: "success", head_sha: "05131e9", display_title: "older code", html_url: "u1" },
            ],
          })
        }
        const m = url.match(/\/runs\/(\d+)\/jobs/)
        if (m) {
          jobCalls.push(m[1])
          // ⚠ run 3 is a DOCS run: it lists the shard job, SKIPPED.
          return json(res, { jobs: m[1] === "3" ? [SHARD_SKIPPED, DOCS] : [SHARD, DOCS] })
        }
        return json(res, {}, 404)
      },
      async (base) => {
        const out = await fetchCandidates({ repo: "o/r", token: "t", apiBase: base })
        // Resolved run 3 (docs, no shards) then run 2 (shards) — and STOPPED.
        expect(jobCalls).toEqual(["3", "2"])
        expect(out.at(-1)).toMatchObject({ runNumber: 5476, ranFullSuite: true })
        // End to end: the decision over what the walk actually returned.
        const { verdict, run } = decideInheritedStatus(out)
        expect(verdict).toBe("red")
        expect(run?.headSha).toBe("3840baf")
      },
    )
  })

  it("never spends a request on its own run", async () => {
    const jobCalls: string[] = []
    await withServer(
      (url, res) => {
        if (url.includes("/workflows/ci.yml/runs")) {
          return json(res, {
            workflow_runs: [
              { id: 9, run_number: 5500, status: "completed", conclusion: "failure", head_sha: "self", display_title: "me", html_url: "u9" },
              { id: 8, run_number: 5481, status: "completed", conclusion: "success", head_sha: "4da64b9", display_title: "fix", html_url: "u8" },
            ],
          })
        }
        const m = url.match(/\/runs\/(\d+)\/jobs/)
        if (m) {
          jobCalls.push(m[1])
          return json(res, { jobs: [SHARD] })
        }
        return json(res, {}, 404)
      },
      async (base) => {
        const out = await fetchCandidates({ repo: "o/r", token: "t", currentRunId: "9", apiBase: base })
        expect(jobCalls).toEqual(["8"])
        expect(decideInheritedStatus(out, { currentRunId: "9" }).verdict).toBe("green")
      },
    )
  })

  it("turns a non-2xx into an ApiError — never an empty list read as `unknown`", async () => {
    await withServer(
      (_url, res) => json(res, { message: "Bad credentials" }, 401),
      async (base) => {
        await expect(fetchCandidates({ repo: "o/r", token: "bad", apiBase: base })).rejects.toBeInstanceOf(
          ApiError,
        )
      },
    )
  })
})

// ── The verdict must be READABLE, not only correct ──────────────────────────
// Measured 2026-09-14 on this guard's first live run: a job's step LOG needs
// admin rights (the API answers 403, the web log endpoints 404), so the only
// observable facts were "the job ran" and "it exited 0" — and `green` and
// `unknown` BOTH exit 0. The one distinction this guard exists to make was
// invisible in its own output. The job summary renders for anyone who can see
// the run, so that is where the verdict goes.

import { renderSummary } from "@/scripts/check-last-code-ci-on-main.mjs"

describe("the job summary distinguishes what the exit code cannot", () => {
  const RUN_OK = { runNumber: 5496, headSha: "abcdef1234", htmlUrl: "https://x/5496", conclusion: "success" }

  it("green and unknown are distinguishable even though both exit 0", () => {
    const green = renderSummary({ verdict: "green", run: RUN_OK, considered: 2 })
    const unknown = renderSummary({ verdict: "unknown", run: null, considered: 0 })
    expect(inheritedExitCode("green")).toBe(inheritedExitCode("unknown")) // the premise
    expect(green).not.toBe(unknown)
    expect(green).toContain("`green`")
    expect(unknown).toContain("`unknown`")
  })

  it("names the run and commit that decided it, as a link", () => {
    const s = renderSummary({ verdict: "red", run: { ...RUN_OK, conclusion: "failure" }, considered: 3 })
    expect(s).toContain("CI #5496")
    expect(s).toContain("https://x/5496")
    expect(s).toContain("abcdef1")
    expect(s).toContain("`failure`")
    // …and must not let a reader blame the docs push in front of them.
    expect(s).toMatch(/not the cause/i)
  })

  it("unknown points at the marker and the permission, not at the history", () => {
    const s = renderSummary({ verdict: "unknown", run: null, considered: 0 })
    expect(s).toContain("SHARD_JOB_MARKER")
    expect(s).toContain("actions: read")
    expect(s).not.toContain("✅")
  })

  it("always reports the population it examined", () => {
    for (const n of [0, 1, 7]) {
      expect(renderSummary({ verdict: "unknown", run: null, considered: n })).toContain(`examined ${n} completed run(s)`)
    }
  })
})
