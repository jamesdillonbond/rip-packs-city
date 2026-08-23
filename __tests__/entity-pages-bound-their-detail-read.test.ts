import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Backtick as a constant: this file has had its escaping eaten by a scripted
// edit more than once tonight (register R42/R19 write-ups). Plain substrings
// and char codes cannot lose a backslash in transit.
const BT = String.fromCharCode(96)

// deep-audit R19 — the half an error boundary CANNOT do.
//
// ── WHY A BOUNDARY IS NOT ENOUGH, MEASURED ─────────────────────────────────
// `app/(collections)/[collection]/error.tsx` shipped first and is in the
// deployed bundle (verified by grepping the served chunk). It did NOT stop
// /nba-top-shot/set/base-set from serving a bare "500: This page couldn't load"
// after 18 s. These routes are ISR (`revalidate` + `dynamicParams`), so the
// throw happens while the page is being GENERATED — not while a mounted tree
// renders — and Next serves its own default error page. The segment boundary
// never runs.
//
// So the detail read has to be bounded in the page body itself.
//
// ── THE DISTINCTION THIS PINS ──────────────────────────────────────────────
// `!detail` means the RPC ANSWERED and the entity does not exist → notFound()
// is true. A THROW means we could not ask → 404 there tells a crawler a real
// page is gone, and de-indexes it. Collapsing the two is the honesty class.

// Measured from Vercel runtime errors, 7 days to 2026-08-23 — the reason each
// page is here, and why this stopped being an SEO item:
//   edition   15,388 throws / 2,963 users   (many from generateMetadata)
//   player     2,062 throws /   528 users
//   pack/dist    581 throws /   515 users
//   series       259 throws /    38 users
//   team          34 throws /     8 users
//   set           24 throws /     1 user
const GUARDED = [
  "app/(collections)/[collection]/set/[slug]/page.tsx",
  "app/(collections)/[collection]/team/[slug]/page.tsx",
  "app/(collections)/[collection]/edition/[slug]/page.tsx",
  "app/(collections)/[collection]/player/[slug]/page.tsx",
  "app/(collections)/[collection]/series/[slug]/page.tsx",
]

function pageBody(src: string): string {
  const i = src.search(/export default async function/)
  return i < 0 ? "" : stripComments(src.slice(i))
}

describe("R19 — entity detail reads are bounded, and a failure is not a 404", () => {
  for (const file of GUARDED) {
    it(`${file.split("/").slice(-3).join("/")} catches a detail-read throw`, () => {
      const body = pageBody(readFileSync(file, "utf8"))
      expect(body).toMatch(/try\s*\{/)
      expect(body).toContain("detailFailed")
      // The load-bearing assertion: the throw path renders something, and it is
      // NOT notFound(). A test asserting only "there is a try" would pass on a
      // catch that called notFound().
      expect(body).toMatch(/if \(detailFailed\) return </)
    })

    it(`${file.split("/").slice(-3).join("/")} leaves NO unguarded data read in the page body`, () => {
      // ⚠ THIS TEST EXISTS BECAUSE THE FIRST VERSION OF IT PASSED ON A BROKEN FIX.
      //
      // I bounded the detail read, shipped, and asserted "there is a try and a
      // detailFailed branch" — which was TRUE and INSUFFICIENT. The heavy
      // Promise.all AFTER it was still unguarded, so the page kept serving Next's
      // default 500 with the fix deployed. Verified live: the served build
      // contained the new copy and the page still 500'd.
      //
      // A test that checks "a guard exists" cannot see the read it does not
      // cover. Assert instead that NO unguarded read remains.
      const body = pageBody(readFileSync(file, "utf8"))

      // The unguarded assignment forms. The guarded rewrite declares the binding
      // first and assigns inside a try, so it does not match these.
      const unguardedAwaitAssign = /^\s*const\s+[\w[\]{},:\s]+=\s*await\s+(fetch\w+|Promise\.all)/gm
      // ⚠ The escaping here was WRONG on the first attempt and the check was
      // silently vacuous: a heredoc ate the backslashes, leaving /^s*consts+.../
      // which matches nothing and passes always. Verified by reverting the fix
      // and watching it still pass. Any guard written by scripted file-edit
      // needs its escaping checked by running it against a KNOWN offender.
      // ⚠ A Promise.all whose EVERY member carries its own .catch() is already
      // safe and must not be flagged — the edition page's streamed block does
      // exactly that (7 fetches, 7 catches) and my first version of this check
      // false-positived on it. A guard that reddens on correct code gets worked
      // around, so the exemption is measured, not assumed: members are counted
      // against catches on the same statement.
      const offenders = [...body.matchAll(unguardedAwaitAssign)]
        .filter((m) => {
          const rest = body.slice(m.index)
          const end = rest.indexOf("])")
          const stmt = end < 0 ? rest.slice(0, 600) : rest.slice(0, end)
          const fetches = (stmt.match(/fetch[A-Z]\w*\(/g) || []).length
          const catches = (stmt.match(/\.catch\(/g) || []).length
          return !(fetches > 0 && catches >= fetches)
        })
      expect(offenders).toEqual([])
    })

    it(`${file.split("/").slice(-3).join("/")} still 404s a genuinely absent entity`, () => {
      // NO-CHANGE CONTROL. Turning every miss into "unavailable" would leave
      // junk slugs indexed and is dishonest in the other direction.
      const body = pageBody(readFileSync(file, "utf8"))
      expect(body).toMatch(/if \(!detail\) notFound\(\)/)
    })
  }

  it("the unavailable state never claims the entity is empty", () => {
    for (const file of GUARDED) {
      const src = readFileSync(file, "utf8")
      const i = src.search(/function \w+Unavailable\(/)
      expect(i).toBeGreaterThan(-1)
      const cmp = src.slice(i)
      expect(cmp).toMatch(/does not mean/)
      // ⚠ A word-ban was tried here first and was WRONG — it fired on
      // "does not mean the set IS EMPTY or gone", which is the correct
      // NEGATION. A static check cannot separate a claim from its denial by
      // keyword, and banning the vocabulary would push the copy toward being
      // vaguer rather than more honest. Assert the disclaimer is PRESENT and
      // that OUR failure is named; do not police the words.
      expect(cmp).toMatch(/problem on our side|could not|didn&rsquo;t come back/i)
    }
  })

  it("pack/dist RENDERS the retryable state instead of throwing for the boundary", () => {
    // ⚠ This page deliberately threw "so the error boundary shows a retryable
    // state". MEASURED: that intent does not hold on an ISR route — the throw
    // happens during generation, error.tsx never runs, and Next serves its own
    // unbranded 500. 581 occurrences / 515 users did exactly that.
    const src = readFileSync("app/(collections)/[collection]/pack/dist/[distId]/page.tsx", "utf8")
    const body = pageBody(src)
    expect(body).toContain("return <PackUnavailable")
    // The throw must be GONE, not merely accompanied by a render.
    expect(body).not.toContain("throw new Error(" + BT + "pack detail bundle unavailable")
    // ...and a genuinely missing dist must still 404.
    expect(body).toContain("notFound()")
  })

  it("records the ISR entity pages still carrying an UNGUARDED detail read", () => {
    // ⚠ A LISTING, NOT A BAN. The remaining pages are the same shape but were not
    // observed failing, and each needs its own degraded copy — so this asserts
    // the population does not GROW rather than pretending it is zero.
    // Deriving it by walking, not by naming, so a new entity route is counted.
    function* walk(dir: string): Generator<string> {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) { if (e.name === "node_modules" || e.name === ".next") continue; yield* walk(full) }
        else if (e.name === "page.tsx") yield full
      }
    }
    const unguarded: string[] = []
    for (const full of walk(join(process.cwd(), "app", "(collections)"))) {
      const src = readFileSync(full, "utf8")
      if (!/export const revalidate/.test(src)) continue
      const body = pageBody(src)
      if (!/notFound\(\)/.test(body)) continue
      if (!/await fetch\w+\(/.test(body)) continue
      if (/detailFailed/.test(body)) continue
      unguarded.push(relative(process.cwd(), full).split(sep).join("/"))
    }
    // edition, player, series, pack/dist — measured 2026-08-22.
    expect(unguarded.length).toBeLessThanOrEqual(4)
  })
})
