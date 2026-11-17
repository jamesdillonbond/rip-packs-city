import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { isMarkerSuppressed } from "../scripts/lib/marker-suppression.mjs"

// BAN AT ZERO on a Telegram `sendMessage` that asks for `parse_mode: "HTML"` and
// has no escaping anywhere in sight.
//
// ── THE CLASS ───────────────────────────────────────────────────────────────
// 🚨 OBSERVED LIVE 2026-09-19, 12:04 PM → 5:04 PM PT. The sentinel's `Cadence
// Collapse` acknowledgement reason contained `baseline_per_day < 400`. That ack
// text is prepended to the check's detail and the detail was interpolated raw
// into a `parse_mode: "HTML"` message, so Telegram answered EVERY send with
//
//     http_400 … "Bad Request: can't parse entities: Unsupported start tag \"\""
//
// The fleet alarm lost its Telegram channel for five hours on a `<` a human
// typed into a NOTE. ⚠ Telegram is stricter than a browser: a bare `<` that does
// not open a tag it recognises is a HARD REJECT, not a literal.
//
// ⭐ It is the alert sub-class in its purest form — a property of the CONTENT
// decides whether the alarm is heard, and the failure's output is silence. The
// texts here are built from ack reasons, lane names, Postgres error strings and
// model-written user text, so angle brackets are not exotic; they are routine.
//
// ── WHY A WALK, AND WHY THIS GUARD EXISTS AT ALL ───────────────────────────
// This is the SECOND time the same population has been swept. The LENGTH defect
// (register #77, 2026-09-11) was fixed across every sender and pinned by
// `telegram-senders-are-all-bounded.test.ts` — a tree walk. The ESCAPING defect
// eight days later was fixed in ONE file and pinned by TWO file-specific tests
// (`sentinel-telegram-lines-are-html-escaped`, `ops-alert-telegram-text-is-html-
// escaped`). So the same population had a walk for one failure mode and a
// curated pair for the other.
//
// 📏 That asymmetry was load-bearing, not cosmetic. A walk on 2026-09-20 found
// `app/api/support-chat/route.ts` still sending the HIGH-severity human
// escalation with `parse_mode: "HTML"` and no escaping, interpolating `reason` —
// which its own comment calls "model-written from a user conversation and
// unbounded". Its `pageDelivered` flag is set only when the send is accepted, so
// one `<` in a user's emergency turned into an honest non-delivery: the user is
// correctly told they were NOT paged, and nobody is paged. CLAUDE.md's rule is
// "grep for the EXPRESSION, not the file"; this is that grep, kept.
//
// ── WHAT COUNTS AS ESCAPED ─────────────────────────────────────────────────
// Any of these, because each genuinely fixes it:
//   * `escapeTelegramHtml(...)` — the shared contract (lib/telegram-message.ts);
//   * a local `escapeHtml(...)` / `esc(...)` — `/api/check-alerts` and
//     `/api/admin/cron/detect-league-drift` predate the shared helper and escape
//     a SUPERSET (`& < > " '`), which is safe for Telegram;
//   * `buildTelegramMessage(...)` — `/api/cron/alerts-send` delegates its whole
//     text to `lib/alerts/format.ts`, which escapes each value there. The escape
//     is real but lives in the BUILDER, so a file-granular check cannot see it.
//
// ⚠ NOT accepted, deliberately: dropping the values. The fix is to escape them
// or to stop asking for HTML — not to stop saying what happened.
//
// ⭐ THE OTHER REAL FIX IS TO REMOVE `parse_mode` ENTIRELY, and this guard is
// written so that doing so REMOVES THE FILE FROM THE POPULATION rather than
// requiring an exemption. A message carrying no markup of its own gets nothing
// from HTML parsing except a failure mode — that is exactly what support-chat's
// escalation was, and how it was fixed.
//
// ── WHAT THIS IS STRUCTURALLY SILENT ABOUT, stated rather than implied ─────
//  1. FILE granularity, same as its length sibling. It asserts that a file
//     asking for HTML parsing also calls an escaper — NOT that every interpolated
//     value in that message is escaped. A file that escapes one of two values
//     passes. Proving the dataflow needs an AST pass; this catches the class that
//     actually occurred twice, which is a sender with no escaping anywhere.
//  2. `parse_mode: "Markdown"` / "MarkdownV2", which have their own (different)
//     escaping rules. No sender here uses them — `app/api/bots/telegram`
//     deliberately strips to plain text instead — so banning HTML-only keeps the
//     population honest rather than pretending to cover a case that does not exist.
//  3. The OTHER channels. Email (Resend) builds its own HTML and is not checked.
// ─────────────────────────────────────────────────────────────────────────────

const ROOTS = ["app", "components", "lib", "workers", "supabase/functions", "scripts"]

/** The API call that can reject on unparseable entities. */
const SEND = /api\.telegram\.org\/bot[^`"']*\/sendMessage/

/** Asking Telegram to PARSE the text as HTML is what creates the hazard. */
const HTML_MODE = /parse_mode\s*:\s*["'`]HTML["'`]/

/** Any accepted escaping mechanism — see "WHAT COUNTS AS ESCAPED" above. */
const ESCAPED = /escapeTelegramHtml|escapeHtml|buildTelegramMessage|\besc\s*\(/

/**
 * Imports are not evidence of escaping — the same mutation that caught the
 * length guard applies here verbatim: deleting the real call leaves the
 * `import { escapeTelegramHtml }` line behind, and a matcher reading raw source
 * goes green on a file whose only trace of the fix is an unused import.
 */
function withoutImports(src: string): string {
  return src
    .split("\n")
    .map((l) => (/^\s*import\b/.test(l) ? "" : l))
    .join("\n")
}

const OPT_OUT = /telegram-html:\s*intentional/
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

function htmlSenders(): { all: string[]; htmlMode: string[]; unescaped: Hit[] } {
  const all: string[] = []
  const htmlMode: string[] = []
  const unescaped: Hit[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      // ⚠ Load-bearing: this file and lib/telegram-message.ts both QUOTE the
      // endpoint AND `parse_mode: "HTML"` in prose. Without stripping, the guard
      // reports its own documentation.
      const stripped = stripComments(raw)
      if (!SEND.test(stripped)) continue
      const file = relative(process.cwd(), full).split(sep).join("/")
      all.push(file)
      if (!HTML_MODE.test(stripped)) continue
      htmlMode.push(file)
      if (ESCAPED.test(withoutImports(stripped))) continue
      const rawLines = raw.split("\n")
      const i = stripped.split("\n").findIndex((l) => HTML_MODE.test(l))
      if (i >= 0 && isMarkerSuppressed(rawLines, i, OPT_OUT, OPT_OUT_LOOKBACK)) continue
      unescaped.push({ file, line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 100) })
    }
  }
  return { all, htmlMode, unescaped }
}

describe("every Telegram sender that asks for HTML escapes its values", () => {
  it("the walk finds the senders at all (not vacuously passing)", () => {
    // ⚠ Asserts the WALK and the HTML-mode SUBSET, never the offender count — a
    // threshold on offenders goes red the moment the population reaches zero,
    // which is the point of a ban at zero.
    const { all, htmlMode } = htmlSenders()
    expect(all.length, "no sendMessage call sites reached — the walk is broken").toBeGreaterThanOrEqual(8)
    expect(
      htmlMode.length,
      "no sender asks for parse_mode HTML — either the walk broke or the whole class is gone;\n" +
        "if genuinely gone, this guard should be retired rather than left passing vacuously",
    ).toBeGreaterThanOrEqual(1)
  })

  it("EVERY root contributes files — a root added but not reached is a silent hole", () => {
    for (const r of ROOTS) {
      expect(walk(join(process.cwd(), r)).length, `root "${r}" reached no files`).toBeGreaterThan(0)
    }
  })

  it("the matcher fires on an unescaped HTML sender and not on an escaped one", () => {
    const base = 'await fetch(`https://api.telegram.org/bot${t}/sendMessage`, { body: JSON.stringify({ text: `a ${v}`, parse_mode: "HTML" }) })'
    const escaped = base.replace("${v}", "${escapeTelegramHtml(v)}")
    const plain = base.replace(', parse_mode: "HTML"', "")

    expect(SEND.test(base) && HTML_MODE.test(base) && !ESCAPED.test(base), "an unescaped HTML sender must be a hit").toBe(true)
    expect(ESCAPED.test(escaped), "escapeTelegramHtml must clear it").toBe(true)
    // ⭐ Dropping parse_mode leaves the population, rather than needing an opt-out.
    expect(HTML_MODE.test(plain), "a sender with no parse_mode is not in the population at all").toBe(false)

    // A local escaper and a delegating builder are real fixes, not exemptions.
    expect(ESCAPED.test(base.replace("${v}", "${escapeHtml(v)}")), "a local escapeHtml must clear it").toBe(true)
    expect(ESCAPED.test(base.replace("`a ${v}`", "buildTelegramMessage(group)")), "a delegating builder must clear it").toBe(true)

    // ⚠ An IMPORT is not an escape — the mutation that caught the length guard.
    const importOnly = `import { escapeTelegramHtml } from "@/lib/telegram-message"\n${base}`
    expect(ESCAPED.test(importOnly), "the raw source still matches on the import alone").toBe(true)
    expect(
      ESCAPED.test(withoutImports(importOnly)),
      "with imports stripped, an unused import must NOT count as an escape",
    ).toBe(false)
  })

  it("the comment stripper is load-bearing (this file would flag itself without it)", () => {
    const doc = '// we POST to https://api.telegram.org/bot<token>/sendMessage with parse_mode: "HTML"\nconst ok = 1'
    expect(SEND.test(doc) && HTML_MODE.test(doc)).toBe(true)
    expect(SEND.test(stripComments(doc))).toBe(false)
  })

  it("no Telegram sender can be rejected for an unparseable entity without saying so", () => {
    const { htmlMode, unescaped } = htmlSenders()
    expect(
      unescaped.length,
      "Telegram REJECTS a parse_mode:\"HTML\" sendMessage whose text contains a bare `<` —\n" +
        'HTTP 400 "can\'t parse entities". These texts are built from ack reasons, lane names,\n' +
        "Postgres errors and model-written user text, so a `<` is routine — and the failure's\n" +
        "output is silence, on the runs that matter most.\n" +
        "Escape the VALUES with escapeTelegramHtml() (lib/telegram-message.ts), or — if the\n" +
        "message carries no markup of its own — drop `parse_mode` entirely, which removes the\n" +
        "failure mode instead of guarding it. If a sender genuinely cannot contain an angle\n" +
        "bracket, say so: add `telegram-html: intentional` WITH THE REASON on the flagged line\n" +
        `or the ${OPT_OUT_LOOKBACK} lines above it.\n` +
        `(${htmlMode.length} parse_mode:"HTML" sender(s) inspected)\n` +
        unescaped.map((h) => `  - ${h.file}:${h.line}  ${h.text}`).join("\n"),
    ).toBe(0)
  })
})
