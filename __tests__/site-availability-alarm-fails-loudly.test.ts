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
const SHIPPED_FAIL_IN_WINDOW = String(step.env.FAIL_IN_WINDOW)
const SHIPPED_WINDOW = String(step.env.WINDOW)

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
        FAIL_IN_WINDOW: SHIPPED_FAIL_IN_WINDOW,
        WINDOW: SHIPPED_WINDOW,
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

  // ── A RECOVERED OUTAGE (added 2026-09-14) ─────────────────────────────────
  //
  // ⚠ WHY THE STREAK ALONE CANNOT SEE ONE. `consecutive_fails` counts backwards
  // from NOW, so a site that went down and came back has a streak of 0 by the
  // time anything looks. That is fine when the looker runs every 15 minutes.
  // It does not, and that is the point: this workflow asks for 96 runs/day and
  // GitHub delivers ~8 (measured 2026-09-14 — 23 starts in 73.8h, median gap
  // ~3.2h, worst 5.58h; `scheduler-liveness` prints the same cap for nine
  // workflows). So the alarm looks about every 3 hours at a window that was
  // 2 hours wide — and any outage that began and ended in between was examined
  // by nothing at all, even though `site_probe` recorded every failure.
  //
  // ⭐ The fix is sized against DELIVERY rather than against the cron, and the
  // threshold against the real series rather than by feel: 949 probes in the
  // retained 3d10h carry TWO failures in total and the worst 8h window holds
  // ONE, so `FAIL_IN_WINDOW = 3` has never fired historically while still
  // catching roughly a quarter-hour of downtime at one probe per ~5 minutes.
  it("FAILS on an outage that already RECOVERED — the streak is 0 and the window is not", () => {
    const n = Number(SHIPPED_FAIL_IN_WINDOW)
    const r = run(payload({ consecutive_fails: 0, failed: n, latest_status: 200 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/WAS DOWN/)
  })

  it("does NOT fire on window failures below the threshold — negative control", () => {
    const below = Number(SHIPPED_FAIL_IN_WINDOW) - 1
    const r = run(payload({ consecutive_fails: 0, failed: below, latest_status: 200 }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Site is serving/)
  })

  it("FAILS CLOSED when the payload carries no `failed` field — UNKNOWN, not healthy", () => {
    // The new read must behave like the two beside it. A missing field that
    // defaulted to 0 would publish "no failures" out of a payload that never
    // said so — this file's own opening paragraph, one field along.
    const noFailed = JSON.stringify({ probes: 24, ok: 24, consecutive_fails: 0, latest_status: 200 })
    const r = run(noFailed)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/UNKNOWN|unreadable/i)
  })

  it("FAILS CLOSED when a threshold is unset, rather than becoming a silent no-op", () => {
    // `[ "$n" -ge "" ]` is simply FALSE in bash, so an unset threshold does not
    // error — it makes the branch unreachable while the workflow still reads as
    // configured. This harness caught exactly that by forwarding only
    // FAIL_STREAK, which is why the check exists and why it is pinned here.
    const r = run(payload({ consecutive_fails: 9, failed: 9, latest_status: 503 }), { FAIL_IN_WINDOW: "" })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/would never fire|UNKNOWN, not healthy/)
  })

  it("asks the RPC for a window WIDER than the worst delivery gap, and does not rely on its default", () => {
    // The RPC's own default is 2h (`p_window interval DEFAULT '02:00:00'`),
    // which is shorter than the median gap between two runs of this workflow.
    // Relying on the default is the defect; passing a wider one is the fix, so
    // both halves are pinned rather than left to a comment.
    expect(step.run).toContain("p_window")
    const hours = Number(String(SHIPPED_WINDOW).split(":")[0])
    expect(hours, "window must clear the 5.58h worst observed delivery gap").toBeGreaterThanOrEqual(6)
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

// ── 2026-09-18 · THE RECOVERED-OUTAGE ALERT MUST BE DATABLE ─────────────────
//
// The alarm fired correctly on commit 5a8ca4e3 — 34 failed probes in its 8 h
// window, every one of them inside the platform outage that ended ~19:01Z, none
// since. ⭐ The problem was not the firing, it was that the message could not be
// dated: "$FAILED failed probes in the last $WINDOW (currently serving again)"
// reads IDENTICALLY whether the last failure was three hours ago or three minutes
// ago. Since the recovered branch re-fires on every delivered tick until those
// failures age out — roughly every 3 h for 8 h at the measured GHA rate — the
// reader gets several undistinguishable repeats, and a GENUINELY NEW outage
// arrives wearing the same string as the one they already dismissed.
//
// ⛔ Deliberately NOT fixed with a cooldown or a higher threshold. This workflow's
// header records that decision ("NO COOLDOWN, DELIBERATELY … the 2026-09-10
// failure was silence, not noise"), and quietening an alarm because it is
// currently right is how the next outage goes unseen. Make the repeats LEGIBLE,
// not fewer.
describe("site-availability-alarm.yml — a recovered outage is DATED, not just counted", () => {
  const n = Number(SHIPPED_FAIL_IN_WINDOW)
  const LAST_FAIL = "2026-09-18T18:57:00.158244+00:00"
  const CLEARS = "2026-09-19T02:57:00.158244+00:00"

  it("names WHEN the last probe failed, so a repeat can be told from a new outage", () => {
    const r = run(
      payload({ consecutive_fails: 0, failed: n, latest_status: 200, last_fail_at: LAST_FAIL, window_clears_at: CLEARS }),
    )
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/WAS DOWN/)
    expect(r.out).toContain(LAST_FAIL)
  })

  it("says when it will stop repeating, so the repeats are not read as new events", () => {
    const r = run(
      payload({ consecutive_fails: 0, failed: n, latest_status: 200, last_fail_at: LAST_FAIL, window_clears_at: CLEARS }),
    )
    expect(r.out).toContain(CLEARS)
    expect(r.out).toMatch(/age out of the window/)
  })

  it("NO-CHANGE CONTROL: still fails loudly when the function is OLDER and omits the fields", () => {
    // ⭐ The whole reason the new reads tolerate blank. These three keys are
    // ADDITIVE, so a deploy ordering where the workflow lands before the migration
    // must NOT lose the alarm — the worst possible outcome of a legibility fix.
    const r = run(payload({ consecutive_fails: 0, failed: n, latest_status: 200 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/WAS DOWN/)
    expect(r.out).not.toMatch(/Last failed probe: \./)
    expect(r.out).not.toMatch(/undefined|null/)
  })

  it("NO-CHANGE CONTROL: the SITE-DOWN-NOW branch is untouched — it is about the present", () => {
    // Without this, "append the clause everywhere" passes the arms above. The
    // streak branch already describes a live outage; dating it would be noise.
    const r = run(payload({ consecutive_fails: Number(SHIPPED_FAIL_STREAK), failed: 99, latest_status: 503 }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/RPC SITE DOWN/)
    expect(r.out).not.toMatch(/age out of the window/)
  })

  it("NO-CHANGE CONTROL: a healthy window still passes, and prints `none` rather than a blank", () => {
    // A window with no failures has NULL for all three — the true answer, not a
    // zero. The log line must render that as `none` so an empty value is never
    // read as a missing field.
    const r = run(payload({ consecutive_fails: 0, failed: 0, latest_status: 200 }))
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/Site is serving/)
    expect(r.out).toMatch(/last_fail_at=none/)
    expect(r.out).toMatch(/window_clears_at=none/)
  })
})
