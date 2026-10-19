import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import path from "path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── FMV confidence is INTERNAL (Trevor, 2026-10-18 8:35 PM PT) ───────────────
// "We shouldn't have anything user-facing that shows our confidence in the
// pricing. That should just be for internal use."
//
// The 07-11 guard (invariants-no-confidence-chips) bans four CHIP shapes in
// app/ only, and exempts the signed-in (analytics) pages. The 10-18 sweep found
// confidence still shown in PROSE, column headers, toggles, OG copy, "thin data"
// caveats and "Verified FMV" framing across app/ AND components/ — none of
// which those four shapes could see. This guard bans the prose and render
// shapes at ZERO over every rendered .tsx in app/ and components/, exempting
// only /admin (internal) and the JSON API routes under app/api (the API keeps
// its `confidence` field by Trevor's call) — app/api/og is rendered, so it is IN.
//
// Facts are not a tier and are allowed: "N sales in 30d", "last sale X days
// ago", "from asks", coverage %. If this fails: delete the label or restate it
// as the fact behind it — never add an exemption.
// Full rule: docs/reference/key-files-and-honesty.md (end).

const REPO = process.cwd()

const BANNED: Array<{ re: RegExp; what: string }> = [
  { re: />[^<>{}\n]*\bconfidence\b[^<>{}\n]*</i, what: "the word 'confidence' in JSX text" },
  { re: /["'`][^"'`\n]*\b[A-Za-z]+[ -]confidence\b[^"'`\n]*["'`]/i, what: "'<tier> confidence' prose in a string" },
  { re: /["'`][^"'`\n]*\bconfidence\s+(?:tier|level|score|label|rating|is|of|in)\b[^"'`\n]*["'`]/i, what: "'confidence <noun>' prose in a string" },
  { re: /["'`]Confidence\b[^"'`\n]*["'`]/, what: "a 'Confidence' label/header" },
  { re: /["'`>](?:High|Med|Low|HIGH|MED|LOW)[ -]?conf\b/, what: "a tier abbreviation ('High conf')" },
  { re: /\{\s*[\w.?]*\b(?:fmv_)?confidence\s*\}/i, what: "a raw confidence value rendered" },
  { re: /\$\{\s*[\w.?]*\b(?:fmv_)?confidence\s*\}/i, what: "a confidence value interpolated into text" },
  { re: />[^<>{}\n]*\bverified[ -]fmv\b|["'`][^"'`\n]*\bverified[ -]fmv\b[^"'`\n]*["'`]/i, what: "'Verified FMV' trust framing" },
  { re: /["'`>][^"'`<>\n]*\bthin[ -](?:data|FMV)\b[^"'`<>\n]*["'`<]/i, what: "a 'thin data / thin FMV' caveat" },
]

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walkTsx(full, out)
    } else if (e.name.endsWith(".tsx")) out.push(full)
  }
  return out
}

const isAdmin = (f: string) => f.split(path.sep).includes("admin")
const isJsonApi = (f: string) => {
  const rel = path.relative(REPO, f).split(path.sep)
  return rel[0] === "app" && rel[1] === "api" && rel[2] !== "og"
}

function scan(files: string[]): string[] {
  const hits: string[] = []
  for (const f of files) {
    const code = stripComments(readFileSync(f, "utf8"))
    code.split("\n").forEach((line: string, i: number) => {
      for (const { re, what } of BANNED) {
        if (re.test(line)) hits.push(`${path.relative(REPO, f)}:${i + 1} — ${what}: ${line.trim().slice(0, 120)}`)
      }
    })
  }
  return hits
}

const ALL = [...walkTsx(path.join(REPO, "app")), ...walkTsx(path.join(REPO, "components"))]
const USER_FACING = ALL.filter((f) => !isAdmin(f) && !isJsonApi(f))

describe("FMV confidence is internal — no user-facing surface shows it (2026-10-18)", () => {
  it("each banned shape matches the defect it names, and not the facts that are allowed", () => {
    const yes = [
      `<td>Confidence</td>`,
      `title="High confidence — 12 sales"`,
      `"HIGH or MEDIUM confidence"`,
      `"confidence tier"`,
      `head={["Item", "Confidence"]}`,
      `<span>High conf</span>`,
      `<span>{r.confidence}</span>`,
      "`FMV ${row.fmv_confidence}`",
      `<label>VERIFIED FMV ONLY</label>`,
      `<span>⚠ thin data</span>`,
    ]
    for (const s of yes) expect(BANNED.some(({ re }) => re.test(s)), s).toBe(true)
    const no = [
      `.select("edition_id, confidence, fmv_usd")`,
      `if (r.confidence === "HIGH") rank += 1`,
      `<span>from asks</span>`,
      `<span>12 sales in 30d</span>`,
      `<span>Coverage 84%</span>`,
      `const lowConfidence = rows.filter(isThin)`,
    ]
    for (const s of no) expect(BANNED.some(({ re }) => re.test(s)), s).toBe(false)
  })

  it("the walk reads the real tree (not vacuous) and the matchers fire on it (admin is a live positive control)", () => {
    expect(USER_FACING.length).toBeGreaterThan(400)
    expect(USER_FACING.some((f) => f.includes(`${path.sep}og${path.sep}`))).toBe(true)
    // The admin pages legitimately show tiers; if this ever reads 0 the matchers have gone blind.
    expect(scan(ALL.filter(isAdmin)).length).toBeGreaterThan(0)
  })

  it("BAN AT ZERO across every user-facing .tsx in app/ and components/", () => {
    const hits = scan(USER_FACING)
    expect(hits, `FMV confidence must not render to visitors (Trevor 2026-10-18):\n${hits.join("\n")}`).toEqual([])
  })
})
