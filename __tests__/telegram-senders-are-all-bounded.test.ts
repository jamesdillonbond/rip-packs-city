import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

// BAN (population ZERO after 2026-09-12) on a Telegram `sendMessage` call site
// that does not bound its text.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// 🚨 Telegram REJECTS a `sendMessage` whose text exceeds 4,096 characters — HTTP
// 400 `"Bad Request: message is too long"` — it does NOT truncate. And the texts
// this repo sends are built one line per finding, so THEIR LENGTH GROWS WITH THE
// SIZE OF THE INCIDENT.
//
// ⭐ So the delivery probability falls as the thing being reported gets worse:
// the alarm is most likely to fail on exactly the runs that matter most, and the
// failure's output is silence. Observed live on 2026-09-11T00:01:09Z, register
// #77: the sentinel concluded CRITICAL during a real outage, Telegram 400'd on
// length, email was `not_configured`, and the only surviving signal was a GitHub
// annotation nobody was watching.
//
// ── WHY A GUARD AND NOT JUST THE FIX ───────────────────────────────────────
// `lib/telegram-message.ts` was written for that incident and THREE call sites
// adopted it. A tree walk on 2026-09-12 found **twelve** `sendMessage` sites, so
// nine were unbounded — including `/api/check-alerts`, the user-facing pipeline
// alerter, measured that day at **~3,250 characters with 13 active alerts, 79 %
// of the cap**, with a per-alert `detail` that has no bound at all.
//
// That is this repo's recorded shape: one bounded read vouching for a row of
// bare siblings. A helper existing is not the same as every sender using it, and
// only a walk can tell the difference.
//
// ── WHAT COUNTS AS BOUNDED ─────────────────────────────────────────────────
// Either is accepted, because both genuinely fix it:
//   * `fitTelegramText(...)` / `fitTelegramMessage(...)` — truncate with a
//     VISIBLE notice (lib/telegram-message.ts);
//   * a splitter that chunks below the limit — `app/api/bots/telegram` already
//     does this for concierge replies and must NOT be "fixed" into truncation.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ─────
//  1. FILE granularity. It asserts that a file calling `sendMessage` also calls
//     a bounding helper — not that the bound is applied to THAT call's text. A
//     file with two senders, one bounded, passes. Proving the dataflow needs a
//     type system or an AST pass; this catches the class that actually occurred,
//     which is a sender written with no bound anywhere in sight.
//  2. The OTHER channels. Email (Resend) and Discord have their own limits and
//     are not checked here.
//  3. Whether the limit is still 4,096. That is Telegram's, not ours, and a
//     change would loosen rather than break this.
// ─────────────────────────────────────────────────────────────────────────────

const ROOTS = ["app", "components", "lib", "workers", "supabase/functions", "scripts"]

/** The API call that carries a length-limited body. */
const SEND = /api\.telegram\.org\/bot[^`"']*\/sendMessage/

/** Any accepted bound: the shared helper, or a local chunker. */
const BOUNDED = /fitTelegramText|fitTelegramMessage|splitForTelegram/

/**
 * Import statements are NOT evidence of bounding, and this line is the whole
 * difference between a guard and a decoration.
 *
 * ⚠ FOUND BY MUTATING THIS GUARD AGAINST THE REAL TREE. Removing the actual
 * `fitTelegramText(...)` call from `/api/check-alerts` — the 79 %-of-cap sender
 * this guard exists for — left the file's `import { fitTelegramText }` line
 * behind, and the first version of this matcher passed on it. So the guard would
 * have gone green for a file whose only remaining trace of the fix was an unused
 * import. Three of four mutations survived that way. Imports are stripped before
 * the test, so only a CALL counts.
 */
function withoutImports(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*import\b/.test(l) ? "" : l))
    .join("\n")
}

const OPT_OUT = /telegram-length:\s*intentional/
const OPT_OUT_LOOKBACK = 3

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue
      walk(full, out)
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !entry.includes(".test.")) {
      out.push(full)
    }
  }
  return out
}

type Hit = { file: string; line: number; text: string }

function senders(): { all: string[]; unbounded: Hit[] } {
  const all: string[] = []
  const unbounded: Hit[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      // ⚠ Load-bearing: this file and lib/telegram-message.ts both QUOTE the
      // endpoint in prose. Without stripping, the guard reports documentation.
      const stripped = stripComments(raw)
      if (!SEND.test(stripped)) continue
      const file = relative(process.cwd(), full).split(sep).join("/")
      all.push(file)
      if (BOUNDED.test(withoutImports(stripped))) continue
      const rawLines = raw.split("\n")
      const i = stripped.split("\n").findIndex((l) => SEND.test(l))
      if (i >= 0 && isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) continue
      unbounded.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 100) })
    }
  }
  return { all, unbounded }
}

describe("every Telegram sender bounds its text", () => {
  it("the walk finds the senders at all (not vacuously passing)", () => {
    // ⚠ Asserts the WALK, never the offender count — a threshold on offenders
    // goes red the moment the population reaches zero, which is the point.
    const { all } = senders()
    expect(all.length, "no sendMessage call sites reached — the walk is broken").toBeGreaterThanOrEqual(8)
  })

  it("EVERY root contributes files — a root added but not reached is a silent hole", () => {
    for (const r of ROOTS) {
      expect(walk(join(process.cwd(), r)).length, `root "${r}" reached no files`).toBeGreaterThan(0)
    }
  })

  it("the matcher fires on an unbounded sender and not on a bounded one", () => {
    const unbounded = 'await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { body: JSON.stringify({ text }) })'
    const bounded = `import { fitTelegramText } from "@/lib/telegram-message"\n${unbounded.replace("{ text }", "{ text: fitTelegramText(text) }")}`
    const chunked = `function splitForTelegram(t){return [t]}\n${unbounded}`
    expect(SEND.test(unbounded) && !BOUNDED.test(unbounded), "an unbounded sender must be a hit").toBe(true)
    expect(SEND.test(bounded) && !BOUNDED.test(bounded), "fitTelegramText must clear it").toBe(false)
    // ⚠ The chunker is a REAL fix, not an exemption: app/api/bots/telegram splits
    // concierge replies below the limit and must not be rewritten into truncation.
    expect(SEND.test(chunked) && !BOUNDED.test(chunked), "a splitter must clear it").toBe(false)

    // ⚠ THE CASE A MUTATION EXPOSED: an IMPORT is not a bound. Removing the real
    // call leaves the import line behind, and a matcher that reads the raw source
    // goes green on it — which is precisely a guard that has stopped guarding.
    const importOnly = `import { fitTelegramText } from "@/lib/telegram-message"\n${unbounded}`
    expect(BOUNDED.test(importOnly), "the raw source still matches on the import alone").toBe(true)
    expect(
      BOUNDED.test(withoutImports(importOnly)),
      "with imports stripped, an unused import must NOT count as a bound",
    ).toBe(false)
  })

  it("the comment stripper is load-bearing (this file would flag itself without it)", () => {
    const doc = "// we POST to https://api.telegram.org/bot<token>/sendMessage\nconst ok = 1"
    expect(SEND.test(doc)).toBe(true)
    expect(SEND.test(stripComments(doc))).toBe(false)
  })

  it("no Telegram sender can be rejected for length without saying so", () => {
    const { all, unbounded } = senders()
    expect(
      unbounded.length,
      "Telegram REJECTS a sendMessage over 4,096 characters with HTTP 400 — it does not\n" +
        "truncate. These texts grow with the size of the incident, so an unbounded sender\n" +
        "fails hardest exactly when it matters most, and its output is silence.\n" +
        "Wrap the text in fitTelegramText() (lib/telegram-message.ts), or chunk it below\n" +
        "the limit. If a sender genuinely cannot exceed 4,096 characters, say so: add\n" +
        "`telegram-length: intentional` WITH THE REASON on the flagged line or the " +
        `${OPT_OUT_LOOKBACK} lines above it.\n` +
        `(${all.length} sendMessage call sites inspected)\n` +
        unbounded.map((h) => `  - ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})
