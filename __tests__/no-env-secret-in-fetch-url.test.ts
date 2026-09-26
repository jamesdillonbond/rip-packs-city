import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, sep } from "node:path"

// ⚠ Paths are compared against ALLOWED, which is written with FORWARD slashes,
// so every path this file reports must be normalised. `join` emits `\` on
// Windows, and an un-normalised offender matches no allowance — which on that
// platform made the two-way check state the OPPOSITE of the truth: it reported
// "the fix has landed" for a leak that is still in the source, and would then
// have flagged the deliberate exemption as a new one. A guard that inverts on
// one platform is worse than no guard, because it reads as a positive result.
const posix = (p: string) => p.split(sep).join("/")

// ── A secret belongs in a HEADER, never in a URL ─────────────────────────────
// Request logs record full URLs. A token in a query string is therefore written
// to a log store on every call, and the tokens in question here are SHARED —
// `INGEST_SECRET_TOKEN` gates ~15 edge functions and a dozen Vercel routes, so
// one leaked URL is not one leaked route.
//
// ⛔ Do NOT "confirm" an instance of this by reading the logs. Reading them IS
// the leak. The caller's SOURCE is the proof, which is what this file checks.
//
// This class has now recurred twice and been fixed twice:
//   · `app/api/cron/sales-serial-backfill/route.ts` — `?token=` to a Supabase
//     edge fn, ~12x/day.
//   · `app/api/ufc-pipeline/route.ts` — `?token=` to two of our own routes; the
//     sales-indexer call was ALREADY sending the correct Bearer header, so its
//     query param was pure redundancy that leaked.
// Two recurrences is what earns a ratchet rather than a third fix.
//
// ⚠ Deliberately scoped to secrets that come from `process.env`. Unsubscribe and
// email-confirm links legitimately carry a per-row token in a URL — that token is
// addressed to one recipient, is not shared, and the URL is the delivery
// mechanism. Widening this to every `?token=` would redden those for no gain.

const ROOTS = ["app", "lib", "scripts"]

// ⚠ THE WALKER'S EXTENSION FILTER IS PART OF THE GUARD'S CLAIM, NOT AN
// IMPLEMENTATION DETAIL. Until 2026-09-18 this ended `else if (/\.(ts|tsx)$/…)`
// while ROOTS still named `scripts`, so the guard read as covering a root it
// structurally could not open: 116 non-TS files there (93 .mjs, 7 .ps1, 6 .sh,
// 5 .py, 2 .js, 2 .bat, 1 .awk) were invisible, and TWO live leaks sat in them
// (R97). A declared root the walker cannot read is a silent root, and a silent
// root reads as coverage. `inspectedByExt` below asserts the walker actually
// opened each family, so this cannot regress back into silence.
const SOURCE_EXT = /\.(ts|tsx|mjs|js|sh|ps1|bat|py)$/

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next") continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (SOURCE_EXT.test(e)) out.push(p)
  }
  return out
}

type Lang = "js" | "sh" | "ps1" | "bat" | "py"

function langOf(file: string): Lang {
  const f = posix(file)
  if (/\.(sh)$/.test(f)) return "sh"
  if (/\.(ps1)$/.test(f)) return "ps1"
  if (/\.(bat)$/.test(f)) return "bat"
  if (/\.(py)$/.test(f)) return "py"
  return "js"
}

/** JS/TS: names assigned from `process.env` anywhere in the file. */
function envBackedNames(src: string): Set<string> {
  const names = new Set<string>()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.[A-Z0-9_]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) names.add(m[1])
  return names
}

// ⚠ The second half of R97: `envBackedNames` above is the ONLY recogniser this
// guard had, and it keys on a JS declaration form. A shell or PowerShell secret
// could therefore never be recognised even once the walker could read the file
// — two mechanisms, either of which alone made the leaks invisible. Each
// language below gets a recogniser in ITS OWN spelling.

/**
 * Shell: a name the script READS but never ASSIGNS comes from the environment
 * (`$INGEST_SECRET_TOKEN` in a script that only ever reads it). Plus locals
 * seeded straight from one of those (`X="${VAR}"` / `X=$VAR`).
 */
function shEnvBackedNames(src: string): Set<string> {
  const assigned = new Set<string>()
  let m: RegExpExecArray | null
  const assignRe = /^\s*(?:export\s+)?([A-Za-z_][\w]*)=/gm
  while ((m = assignRe.exec(src))) assigned.add(m[1])

  const names = new Set<string>()
  const refRe = /\$\{?([A-Za-z_][\w]*)\}?/g
  while ((m = refRe.exec(src))) if (!assigned.has(m[1])) names.add(m[1])

  const aliasRe = /^\s*(?:export\s+)?([A-Za-z_][\w]*)=\s*"?\$\{?([A-Za-z_][\w]*)\}?"?\s*$/gm
  while ((m = aliasRe.exec(src))) if (names.has(m[2])) names.add(m[1])
  return names
}

/** PowerShell: `$env:VAR` is the environment itself; `$X = $env:VAR` aliases it. */
function ps1EnvBackedNames(src: string): Set<string> {
  const names = new Set<string>()
  let m: RegExpExecArray | null
  const direct = /\$env:([A-Za-z_][\w]*)/g
  while ((m = direct.exec(src))) names.add("env:" + m[1])
  const alias = /\$([A-Za-z_][\w]*)\s*=\s*\$env:[A-Za-z_][\w]*/g
  while ((m = alias.exec(src))) names.add(m[1])
  // one more hop: `$B = $A` where $A is already env-backed.
  const hop = /\$([A-Za-z_][\w]*)\s*=\s*\$([A-Za-z_][\w]*)\s*$/gm
  while ((m = hop.exec(src))) if (names.has(m[2])) names.add(m[1])
  return names
}

/** cmd.exe: `%VAR%` that no `set VAR=` in the file defines. */
function batEnvBackedNames(src: string): Set<string> {
  const assigned = new Set<string>()
  let m: RegExpExecArray | null
  const setRe = /^\s*set\s+(?:\/[ap]\s+)?"?([A-Za-z_][\w]*)=/gim
  while ((m = setRe.exec(src))) assigned.add(m[1].toUpperCase())
  const names = new Set<string>()
  const refRe = /%([A-Za-z_][\w]*)%/g
  while ((m = refRe.exec(src))) if (!assigned.has(m[1].toUpperCase())) names.add(m[1])
  return names
}

/** Python: `X = os.environ[...] / os.environ.get(...) / os.getenv(...)`. */
function pyEnvBackedNames(src: string): Set<string> {
  const names = new Set<string>()
  const re = /([A-Za-z_]\w*)\s*=\s*os\.(?:environ|getenv)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) names.add(m[1])
  return names
}

const RECOGNISER: Record<Lang, (src: string) => Set<string>> = {
  js: envBackedNames,
  sh: shEnvBackedNames,
  ps1: ps1EnvBackedNames,
  bat: batEnvBackedNames,
  py: pyEnvBackedNames,
}

/** Does this language read the environment at all? Cheap pre-filter. */
const ENV_MARKER: Record<Lang, RegExp> = {
  js: /process\.env/,
  sh: /\$\{?[A-Za-z_]/,
  ps1: /\$env:|\$[A-Za-z_]/,
  bat: /%[A-Za-z_][\w]*%/,
  py: /os\.(?:environ|getenv)/,
}

const IS_COMMENT: Record<Lang, (t: string) => boolean> = {
  js: (t) => t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"),
  sh: (t) => t.startsWith("#"),
  ps1: (t) => t.startsWith("#") || t.startsWith("<#"),
  bat: (t) => /^(?:rem\b|::)/i.test(t),
  py: (t) => t.startsWith("#"),
}

const KEYS = "token|key|secret|api_key|apikey|access_token"

/**
 * The interpolation spelling differs per language, so the offender pattern does
 * too. Each captures the NAME placed after `?key=` / `&token=`; the caller then
 * checks that name against the language's env-backed set.
 */
function offenderRe(lang: Lang): RegExp {
  switch (lang) {
    case "js":
      return new RegExp(`[?&](?:${KEYS})=\\$\\{\\s*(?:encodeURIComponent\\(\\s*)?([A-Za-z_$][\\w$]*)`, "gi")
    case "sh":
      return new RegExp(`[?&](?:${KEYS})=\\$\\{?([A-Za-z_][\\w]*)`, "gi")
    case "ps1":
      return new RegExp(`[?&](?:${KEYS})=\\$((?:env:)?[A-Za-z_][\\w]*)`, "gi")
    case "bat":
      return new RegExp(`[?&](?:${KEYS})=%([A-Za-z_][\\w]*)%`, "gi")
    case "py":
      return new RegExp(`[?&](?:${KEYS})=\\{\\s*([A-Za-z_][\\w]*)`, "gi")
  }
}

describe("no env-backed secret is interpolated into a fetch URL", () => {
  it("every source file keeps process.env secrets out of query strings", () => {
    const offenders: string[] = []
    const inspectedByExt: Record<string, number> = {}

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const lang = langOf(file)
        const ext = posix(file).replace(/^.*\./, "")
        inspectedByExt[ext] = (inspectedByExt[ext] ?? 0) + 1

        const src = readFileSync(file, "utf8")
        if (!ENV_MARKER[lang].test(src)) continue
        const envNames = RECOGNISER[lang](src)
        if (envNames.size === 0) continue

        const re = offenderRe(lang)
        const isComment = IS_COMMENT[lang]
        const lines = src.split("\n")
        lines.forEach((line, i) => {
          // Ignore comments — this rule is DOCUMENTED in prose in the very files
          // that fixed it, and an unanchored match would fire on its own warning.
          const t = line.trimStart()
          if (isComment(t)) return

          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(line))) {
            if (envNames.has(m[1])) {
              offenders.push(`${posix(file)}:${i + 1}  ${t.slice(0, 100)}`)
            }
          }
        })
      }
    }

    // ── The walker must actually have OPENED each family ──────────────────
    // ⚠ THE TELL IS SILENCE. R97 was not a wrong answer, it was an unasked
    // question: the guard passed while reading none of `scripts/`'s 116 non-TS
    // files. A population count is the only thing that separates "found no
    // leaks" from "opened no files", so assert it rather than trusting the
    // extension list above to stay correct. Written as `> 0` per family so the
    // guard cannot be reddened by someone legitimately deleting a script.
    for (const ext of ["ts", "mjs", "sh", "ps1", "py"]) {
      expect(
        inspectedByExt[ext] ?? 0,
        `The walker opened ZERO .${ext} files under ${ROOTS.join(", ")}. Either the ` +
          `extension filter regressed or a declared root moved — in both cases this ` +
          `test is silently covering nothing, which is exactly the R97 failure.`,
      ).toBeGreaterThan(0)
    }

    // ── The allowance, and why it is two-way ──────────────────────────────
    // ✅ The first allowance (app/api/ufc-wallet-scan/route.ts → enrich-ufc-wallet
    // `?token=`) was RETIRED 2026-09-25: the fn's header branch was deployed from
    // the committed file by .github/workflows/edge-fn-deploy.yml (drift census
    // `clean`), then both callers moved to the Authorization header. Exactly the
    // two-way exit described below — the entry stopped matching and was deleted.
    //
    // ⚠ The check runs in BOTH directions on purpose. An allowance that merely
    // suppresses is how a "temporary" exception becomes permanent: once the
    // deploy lands and the caller moves to a header, this entry stops matching
    // and the test FAILS, telling you to delete the allowance. A one-way
    // allowlist would have gone quiet instead and left the exemption in place
    // guarding nothing — the same shape as a guard that keeps shouting after
    // its fix, just inverted.
    //
    // ⚠ SECOND ENTRY, SEEDED 2026-09-18 WITH R97. Widening the walker to .sh /
    // .ps1 / .mjs / .js / .bat / .py surfaced exactly two pre-existing leaks in
    // `scripts/`. `run-bulk-classify.sh` was FIXED in the same change (the route
    // grew an Authorization branch, and the script now sends it). The PowerShell
    // one below could NOT be: it calls the Supabase edge fn
    // `ingest-topshot-atlas-pool`, whose only auth branch is
    // `url.searchParams.get("key") !== KEY` (supabase/functions/
    // ingest-topshot-atlas-pool/index.ts:94) — there is no header branch to move
    // to, so a script-side "fix" would 401 every harvest run. The real fix is the
    // same 3-step order used for sales-serial-backfill: (a) deploy a header
    // branch on the edge fn, (b) move this caller to the header, (c) delete the
    // fn's ?key= branch. (a) is an edge DEPLOY and is not a repo change.
    // ⚠ This is an allowance, not an absolution: ATLAS_POOL_INGEST_KEY is written
    // into Supabase edge logs on every harvest and should be treated as exposed.
    const ALLOWED = [
      "scripts/atlas-pool-harvest.ps1",
    ]

    const unexpected = offenders.filter(
      (o) => !ALLOWED.some((a) => o.startsWith(a + ":")),
    )
    const staleAllowances = ALLOWED.filter(
      (a) => !offenders.some((o) => o.startsWith(a + ":")),
    )

    expect(
      staleAllowances,
      `An allowance in this test no longer matches any leak — the fix has landed.\n` +
        `DELETE the entry (and the comment block explaining it) rather than leaving\n` +
        `an exemption that guards nothing:\n\n` + staleAllowances.join("\n"),
    ).toEqual([])

    expect(
      unexpected,
      `A secret read from process.env is being placed in a URL query string.\n` +
        `Send it as an Authorization header instead — request logs record full URLs.\n` +
        `⛔ Do not read the logs to assess the impact; reading them is the leak.\n\n` +
        unexpected.join("\n"),
    ).toEqual([])
  })
})
