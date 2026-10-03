import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * ── WHY THIS EXISTS (register R77, 2026-10-03) ─────────────────────────────
 * Every pager in this estate was sent BY the sentinel route, so when the route
 * could not finish nothing was sent at all. On 2026-09-18 (#122) this workflow
 * fired at 16:38Z, got `504 FUNCTION_INVOCATION_TIMEOUT` three times and went
 * red — and its fallback write to Supabase got Cloudflare `522`, so the
 * outage existed in that GitHub log and nowhere else. The step pinned here
 * pages runner → Telegram, touching neither Vercel nor Supabase.
 *
 * Every case EXECUTES the shipped `run:` body with `curl` shadowed (the
 * convention of sentinel-workflow-records-that-it-tried.test.ts): the contract
 * is a decision — response in, page out — so the assertions are that decision.
 */

const ROOT = join(__dirname, "..")
const WORKFLOW = parse(readFileSync(join(ROOT, ".github/workflows/pipeline-sentinel.yml"), "utf8")) as any
const STEP_NAME = "Page Telegram directly from the runner"

type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> }
const step = (): Step => {
  const s = (WORKFLOW.jobs.sentinel.steps as Step[]).find((x) => x.name === STEP_NAME)
  if (!s?.run) throw new Error(`no step named ${JSON.stringify(STEP_NAME)}`)
  return s
}

function runPage(env: Record<string, string>, curlStdout = "200") {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-page-"))
  const urlPath = join(dir, "url")
  const dataPath = join(dir, "data")
  const shadow = [
    `curl () {`,
    `  while [ $# -gt 0 ]; do`,
    `    case "$1" in`,
    `      -d) printf '%s' "$2" > "${dataPath}"; shift ;;`,
    `      -X) printf '%s' "$3" > "${urlPath}"; shift ;;`,
    `    esac`,
    `    shift`,
    `  done`,
    `  printf '%s' "$CURL_STDOUT"`,
    `}`,
  ].join("\n")
  let code = 0
  let out = ""
  try {
    out = execFileSync("bash", ["-e", "-c", `${shadow}\n${step().run}`], {
      env: { PATH: process.env.PATH, CURL_STDOUT: curlStdout, ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e: any) {
    code = e.status ?? -1
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`
  }
  return {
    code,
    out,
    url: existsSync(urlPath) ? readFileSync(urlPath, "utf8") : null,
    data: existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf8")) : null,
  }
}

const SECRETS = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "-10042" }
const RUN_URL = "https://github.com/o/r/actions/runs/1"

describe("pipeline-sentinel.yml pages Telegram itself when the route cannot", () => {
  it("⭐ sends a page naming the status and marker, to the configured chat", () => {
    const r = runPage({ ...SECRETS, HTTP_CODE: "504", MARKER: "function_invocation_timeout", RUN_URL })
    expect(r.code).toBe(0)
    expect(r.url).toBe("https://api.telegram.org/bot123:abc/sendMessage")
    expect(r.data.chat_id).toBe("-10042")
    expect(r.data.text).toContain("RPC SENTINEL UNREACHABLE")
    expect(r.data.text).toContain("HTTP 504 (function_invocation_timeout)")
    expect(r.data.text).toContain(RUN_URL)
    expect(r.out).toContain("paged Telegram from the runner")
  })

  // CLAUDE.md: every time reported to Trevor is PT, never UTC.
  it("stamps the page in PT, never UTC", () => {
    const r = runPage({ ...SECRETS, HTTP_CODE: "504", MARKER: "none", RUN_URL })
    expect(r.data.text).toMatch(/ PT\./)
    expect(r.data.text).not.toMatch(/UTC|\dZ\b/)
  })

  it("forwards ONLY bounded tokens — a hostile status or marker cannot inject text", () => {
    const r = runPage({ ...SECRETS, HTTP_CODE: "5<b>04 secret", MARKER: "x\"; DROP <i>", RUN_URL })
    // digits only for the status; lowercase letters and `_` only for the marker
    expect(r.data.text).toContain("HTTP 504 (xi)")
    expect(r.data.text).not.toMatch(/<|>|secret|DROP|"/)
  })

  it("without the secrets it warns, sends nothing, and does not change the job's result", () => {
    const r = runPage({ HTTP_CODE: "504", MARKER: "none", RUN_URL })
    expect(r.code).toBe(0)
    expect(r.url).toBeNull()
    expect(r.out).toContain("are not GitHub secrets")
  })

  it("a rejected page is said out loud, and still never fails the step", () => {
    const r = runPage({ ...SECRETS, HTTP_CODE: "504", MARKER: "none", RUN_URL }, "400")
    expect(r.code).toBe(0)
    expect(r.out).toContain("Telegram did NOT accept")
  })

  it("runs only on unreachability, even after the sentinel step failed", () => {
    const cond = step().if ?? ""
    expect(cond).toContain("always()")
    expect(cond).toContain("steps.sentinel.outputs.unreachable == 'true'")
  })

  it("reads the token from GitHub secrets, not from anything Vercel or Supabase serves", () => {
    const env = step().env ?? {}
    expect(env.TELEGRAM_BOT_TOKEN).toBe("${{ secrets.TELEGRAM_BOT_TOKEN }}")
    expect(env.TELEGRAM_CHAT_ID).toBe("${{ secrets.TELEGRAM_CHAT_ID }}")
    expect(step().run).not.toMatch(/SUPABASE_URL|rest\/v1|rippackscity\.com/)
  })
})
