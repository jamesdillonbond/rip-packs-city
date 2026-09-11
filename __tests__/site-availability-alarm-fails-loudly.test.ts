import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * On 2026-09-10 a Vercel spend-cap pause took the site down for ~10 hours and it
 * was found BY ACCIDENT (#76). Every detector was a casualty of the same pause or
 * asleep. Postgres was the one plane that survived, so `probe_site_health()`
 * probes the site from inside the database and this workflow is the half that
 * shouts about it — GitHub Actions being the other system with no Vercel in it.
 *
 * ⚠ THE CONTRACT IS THAT IT FAILS. Every other ops workflow here is warn-only on
 * purpose; this one is the alarm, and the cases below pin the exact states that
 * must turn it red. The two that matter most are the ones that are NOT "the site
 * returned an error":
 *   - ZERO probes in the window — the prober itself stopped, so the alarm is
 *     blind and must say so rather than reporting green;
 *   - an unreadable or non-200 RPC — the site's state is UNKNOWN, not healthy.
 * Both are the shape this repo keeps paying for: an absence rendered as an answer.
 */

const ROOT = join(__dirname, "..")
const WORKFLOWS = join(ROOT, ".github", "workflows")
const SELF = "site-availability-alarm.yml"
const doc = parse(readFileSync(join(WORKFLOWS, SELF), "utf8")) as any
const step = doc.jobs.availability.steps.find((s: any) => typeof s.run === "string")
/**
 * ⚠ THE SHIPPED THRESHOLD, NOT ONE THE HARNESS INVENTS. The first version of this
 * file passed FAIL_STREAK: "3" into every run, so changing the workflow's own
 * value to 1 — which would make the alarm fire on every single blip — broke no
 * test. A fixture that overrides the shipped configuration tests the harness.
 */
const SHIPPED_FAIL_STREAK = String(step.env.FAIL_STREAK)

/** Run the shipped script with curl shadowed: the RPC call gets `fixture`, Telegram gets a code. */
function run(fixture: string, env: Record<string, string> = {}, httpCode = "200") {
  const shadow = [
    `curl () {`,
    `  for a in "$@"; do case "$a" in *api.telegram.org*) printf '200'; return 0;; esac; done`,
    `  printf '%s\\n%s' "$FIXTURE" "$HTTP_CODE"`,
    `}`,
  ].join("\n")

  const ghExprs = step.run.match(/\$\{\{[^}]*\}\}/g) ?? []
  expect(ghExprs.length, "run: body should carry no GitHub expressions (they live in env:)").toBe(0)

  try {
    const out = execFileSync("bash", ["-e", "-c", `${shadow}\n${step.run}`], {
      env: {
        ...process.env,
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_KEY: "harness-key",
        FAIL_STREAK: SHIPPED_FAIL_STREAK,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: "",
        FIXTURE: fixture,
        HTTP_CODE: httpCode,
        ...env,
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ probes: 24, ok: 24, failed: 0, consecutive_fails: 0, latest_status: 200, ...over })

describe("site-availability-alarm.yml", () => {
  it("passes when the database says the site is serving", () => {
    const r = run(payload())
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Site is serving/)
  })

  it("keeps a threshold that cannot fire on a single blip", () => {
    // A threshold of 1 turns the one alarm allowed to be loud into noise.
    expect(Number(SHIPPED_FAIL_STREAK)).toBeGreaterThanOrEqual(2)
    expect(Number(SHIPPED_FAIL_STREAK)).toBeLessThanOrEqual(6)
  })

  it("FAILS once the failure streak reaches the threshold", () => {
    const n = Number(SHIPPED_FAIL_STREAK)
    const r = run(payload({ consecutive_fails: n, failed: n, latest_status: 503 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/SITE DOWN/)
    expect(r.out).toMatch(/503/)
  })

  it("does NOT fire on a single blip below the threshold", () => {
    // Negative control. A 5-minute probe failing once is a blip; firing on it
    // would train the reader to ignore the one alarm that is allowed to be loud.
    const below = Number(SHIPPED_FAIL_STREAK) - 1
    const r = run(payload({ consecutive_fails: below, failed: below, latest_status: 503 }))
    expect(r.code).toBe(0)
  })

  it("FAILS when the prober itself recorded zero probes — blind, not healthy", () => {
    // The failure this repo keeps repeating: an empty population reading as a
    // clean result. If pg_cron stopped, this alarm knows nothing and must say so.
    const r = run(payload({ probes: 0, ok: 0, failed: 0 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/BLIND|ZERO probes/)
  })

  it.each([
    ["a non-200 from the RPC", payload(), "500"],
    ["an empty body", "", "200"],
    ["a body that is not JSON", "<html>nope</html>", "200"],
  ])("FAILS on %s — UNKNOWN is not healthy", (_label, fixture, code) => {
    const r = run(fixture, {}, code)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/UNKNOWN|unreadable/i)
  })

  it("FAILS when it has no credentials to check with", () => {
    // Unlike the warn-only backstop, an alarm that cannot verify must not pass.
    const r = run(payload(), { SUPABASE_URL: "", SUPABASE_KEY: "" })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/UNKNOWN, not healthy/)
  })

  it("still fails, and says why no message went out, when Telegram is unconfigured", () => {
    // The bot token lives in Vercel env today — the exact plane that disappears
    // in this outage. Until it is a GitHub secret the badge is the only signal,
    // and the run must say that rather than implying someone was told.
    const r = run(payload({ consecutive_fails: 4, latest_status: 503 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/::warning::.*TELEGRAM_BOT_TOKEN/)
  })

  it("sends Telegram when the secrets are present", () => {
    const r = run(payload({ consecutive_fails: 4, latest_status: 503 }), {
      TELEGRAM_BOT_TOKEN: "tok",
      TELEGRAM_CHAT_ID: "123",
    })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/telegram HTTP 200/)
    expect(r.out).not.toMatch(/::warning::.*TELEGRAM_BOT_TOKEN/)
  })

  it("schedules on minutes no other workflow in this repo uses", () => {
    const mine = new Set(String(doc.on.schedule[0].cron).split(" ")[0].split(",").map((m) => m.trim()))
    const others = new Set<string>()
    for (const f of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") && f !== SELF)) {
      for (const m of readFileSync(join(WORKFLOWS, f), "utf8").matchAll(/cron:\s*['"]([^'"]+)['"]/g)) {
        for (const part of m[1].split(" ")[0].split(",")) if (/^\d+$/.test(part.trim())) others.add(part.trim())
      }
    }
    expect(others.size, "the comparison set must be non-empty or this asserts nothing").toBeGreaterThan(10)
    for (const m of mine) expect(others.has(m), `minute ${m} collides with another workflow`).toBe(false)
  })
})
