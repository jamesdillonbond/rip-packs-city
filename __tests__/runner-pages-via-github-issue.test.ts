import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * ── WHY THIS EXISTS (register R77, 2026-10-03) ─────────────────────────────
 * The runner-side Telegram pages need two GitHub secrets that are not set, the
 * Actions secrets API is closed to the autonomous sessions, and a bot token
 * must never pass through a transcript. So the page that works TODAY is a
 * GitHub issue opened with the workflow's own token: GitHub's notification
 * plane is neither Vercel nor Supabase. These cases EXECUTE the shipped script
 * with `gh` shadowed, so what is pinned is the decision: existing open issue →
 * comment; none → create; gh failing → a warning and exit 0, never a changed
 * job result. The two workflows are pinned to grant `issues: write` and to
 * run the step on the same condition as their Telegram page.
 *
 * ⚠ 2026-10-03 LIVE TEST (pager-test.yml, runs 37165170411 / 37165210008): the
 * first version passed here and still opened TWO issues (#16, #17), because it
 * used `gh issue list --jq --arg t …` — gh's --jq has no --arg, gh failed,
 * 2>/dev/null ate it, and "none open" was the result. A shadow that answers
 * any `issue list` cannot see a flag gh would reject. So the shadow now (a)
 * answers only `gh api repos/<repo>/issues?…` with the REST shape and (b)
 * EXITS 1 on any `--arg`, which is the planted defect that makes the old
 * script red here. The decision is still proven end to end only by a dispatch.
 */

const ROOT = join(__dirname, "..")
const SCRIPT = join(ROOT, "scripts/ci/page-via-github-issue.sh")

type OpenIssue = { number: number; title: string }
function run(env: Record<string, string>, ghBehaviour: { open?: OpenIssue[]; createFails?: boolean; commentFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-page-"))
  const log = join(dir, "gh.log")
  const gh = join(dir, "gh")
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> "${log}"`,
      `for a in "$@"; do [ "$a" = "--arg" ] && { echo "unknown flag: --arg" >&2; exit 1; }; done`,
      `case "$1 $2" in`,
      `  "api repos/o/r/issues?state=open&labels=pager&per_page=50") printf '%s' '${(ghBehaviour.open ?? []).map((i) => `${i.number}\t${i.title}`).join("\n")}' ;;`,
      `  "api "*) echo "unexpected api path: $2" >&2; exit 1 ;;`,
      `  "issue list") echo "issue list is not used (R77 live test 2026-10-03)" >&2; exit 1 ;;`,
      `  "issue create") ${ghBehaviour.createFails ? "exit 1" : "echo https://github.com/o/r/issues/42"} ;;`,
      `  "issue comment") ${ghBehaviour.commentFails ? "exit 1" : "echo ok"} ;;`,
      `  "label create") exit 0 ;;`,
      `esac`,
    ].join("\n"),
  )
  chmodSync(gh, 0o755)
  let code = 0
  let out = ""
  try {
    out = execFileSync("bash", [SCRIPT], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        GH_TOKEN: "t",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REPOSITORY_OWNER: "o",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "7",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e: any) {
    code = e.status ?? -1
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`
  }
  const calls = existsSync(log) ? readFileSync(log, "utf8") : ""
  return { code, out, calls }
}

describe("scripts/ci/page-via-github-issue.sh", () => {
  it("creates an issue that @-mentions the owner when no open issue carries the title", () => {
    const r = run({ PAGE_TITLE: "RPC SENTINEL UNREACHABLE", PAGE_BODY: "answered HTTP 504 (timeout)" }, { open: [] })
    expect(r.code).toBe(0)
    expect(r.calls).toMatch(/issue create .*--title RPC SENTINEL UNREACHABLE/)
    expect(r.calls).toMatch(/--body @o answered HTTP 504 \(timeout\)/)
    expect(r.calls).toMatch(/--label pager/)
    expect(r.out).toContain("paged via new GitHub issue")
  })

  it("comments on the existing open issue instead of opening a second one", () => {
    const r = run(
      { PAGE_TITLE: "RPC SITE DOWN", PAGE_BODY: "3 consecutive failed probes" },
      { open: [{ number: 9, title: "RPC SENTINEL UNREACHABLE" }, { number: 17, title: "RPC SITE DOWN" }] },
    )
    expect(r.code).toBe(0)
    expect(r.calls).toMatch(/issue comment 17 /)
    expect(r.calls).not.toMatch(/issue create/)
    expect(r.out).toContain("paged via GitHub issue #17")
  })

  it("matches the title EXACTLY — a near-miss open issue does not swallow a different page", () => {
    const r = run(
      { PAGE_TITLE: "RPC PAGER TEST — close me when seen", PAGE_BODY: "x" },
      { open: [{ number: 3, title: "RPC PAGER TEST" }, { number: 4, title: "rpc pager test — close me when seen" }] },
    )
    expect(r.calls).toMatch(/issue create/)
    expect(r.calls).not.toMatch(/issue comment/)
    // and the same title with the em dash and spaces intact IS matched
    const r2 = run(
      { PAGE_TITLE: "RPC PAGER TEST — close me when seen", PAGE_BODY: "x" },
      { open: [{ number: 16, title: "RPC PAGER TEST — close me when seen" }] },
    )
    expect(r2.calls).toMatch(/issue comment 16 /)
  })

  it("never changes the job's result: gh failing is a ::warning:: and exit 0", () => {
    const r = run({ PAGE_TITLE: "x", PAGE_BODY: "y" }, { open: [], createFails: true })
    expect(r.code).toBe(0)
    expect(r.out).toContain("::warning::")
    const r2 = run({ PAGE_TITLE: "x", PAGE_BODY: "y" }, { open: [{ number: 3, title: "x" }], commentFails: true })
    expect(r2.code).toBe(0)
    expect(r2.out).toContain("::warning::")
  })

  it("with no title/body or no token it says so and exits 0 — it does not invent a page", () => {
    const r = run({ PAGE_TITLE: "", PAGE_BODY: "" })
    expect(r.code).toBe(0)
    expect(r.calls).toBe("")
    expect(r.out).toContain("nothing paged")
  })
})

describe("both runner-side alarms wire the issue page", () => {
  type Step = { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> }
  const wf = (f: string) => parse(readFileSync(join(ROOT, ".github/workflows", f), "utf8")) as any

  it("pipeline-sentinel.yml grants issues: write and pages on the SAME condition as the Telegram step", () => {
    const w = wf("pipeline-sentinel.yml")
    expect(w.permissions.issues).toBe("write")
    const steps = w.jobs.sentinel.steps as Step[]
    const tg = steps.find((s) => s.name === "Page Telegram directly from the runner")!
    const gh = steps.find((s) => s.name === "Page via GitHub issue (no secret needed)")!
    expect(gh.if).toBe(tg.if)
    expect(gh.env?.GH_TOKEN).toBe("${{ github.token }}")
    expect(gh.run).toContain("scripts/ci/page-via-github-issue.sh")
    expect(gh.run).toContain("PAGE_TITLE=")
  })

  it("site-availability-alarm.yml writes page outputs before EVERY runtime red exit and pages on them", () => {
    const w = wf("site-availability-alarm.yml")
    expect(w.permissions.issues).toBe("write")
    const steps = w.jobs.availability.steps as Step[]
    const read = steps.find((s) => s.id === "avail")!
    expect(read, "the read step is id: avail").toBeTruthy()
    // every `exit 1` except the two config guards (no credentials / thresholds unset — CI-visible
    // misconfiguration, not an outage) is preceded by a page_title write
    const body = read.run!
    const exits = body.split("\n").map((l, i) => [l, i] as const).filter(([l]) => /^\s*exit 1\s*$/.test(l))
    expect(exits.length).toBeGreaterThanOrEqual(5)
    const lines = body.split("\n")
    let paged = 0
    for (const [, i] of exits) {
      const window = lines.slice(Math.max(0, i - 3), i).join("\n")
      if (/page_title=/.test(window)) paged++
    }
    expect(paged).toBe(exits.length - 2)
    expect(paged).toBeGreaterThanOrEqual(5)
    const gh = steps.find((s) => s.name === "Page via GitHub issue (no secret needed)")!
    expect(gh.if).toContain("steps.avail.outputs.page_title != ''")
    expect(gh.env?.PAGE_TITLE).toBe("${{ steps.avail.outputs.page_title }}")
    expect(gh.run).toContain("scripts/ci/page-via-github-issue.sh")
  })
})
