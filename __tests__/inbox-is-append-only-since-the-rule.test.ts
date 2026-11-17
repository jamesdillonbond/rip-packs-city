// `docs/overnight/inbox/` is APPEND-ONLY. Nothing filed on or after 2026-08-17
// may be moved into `inbox/archive/`.
//
// ── WHY THIS EXISTS, AND WHY PROSE WAS NOT ENOUGH ───────────────────────────
// `docs/overnight/focus.md` has carried the rule since 2026-08-17, with its
// reasoning and its evidence: inbox filings are **permanent citation targets**,
// referenced by exact path from CLAUDE.md, the ledger, a dozen handoffs, the
// roadmap, the session logs, **four committed `supabase/migrations/*.sql`** and
// **`lib/analytics/rpc-with-retry.ts`** (live product source). A `git mv` breaks
// every one of them, and a migration is immutable history that must not be
// edited to chase a path. The rule ends: *"the convention and the citation
// practice are in conflict, and the citations win."*
//
// ⚠ ON 2026-08-23 THE OVERNIGHT PASS ARCHIVED TWO FILINGS ANYWAY, six days after
// the rule was written, and both were cited by path from the ledger. It was not
// malice or carelessness — the `inbox/` convention still SAYS files are archived
// after draining, the pass had drained them, and the only thing saying otherwise
// was a paragraph in a file it had no reason to re-read. **A rule that lives only
// in prose is a rule that holds until someone follows the older convention.**
//
// ⚠ IT WAS CAUGHT BY ACCIDENT, WHICH IS THE OTHER HALF OF THE ARGUMENT.
// `inbox-index-lists-every-filing` reddened on the DANGLING LINKS in INDEX.md —
// but only because those two filings happened to have been indexed first. A
// filing archived before it reached INDEX.md would have been moved silently, and
// every ledger citation to it would have rotted with nothing going red.
//
// ── THE CUTOFF, AND WHY IT IS A DATE RATHER THAN A BAN ──────────────────────
// 275 files sit in `archive/` from before the rule. They are history and the rule
// was not retroactive, so a blanket ban would red on its own past and could never
// reach zero — the shape this repo records as "a guard that punishes its own
// success". The cutoff is the DATE THE RULE WAS MEASURED, so the check is
// satisfiable at a population of zero and is exactly as strict as the rule it
// enforces. Measured 2026-08-23: **0 files on/after the cutoff sit in archive/**,
// which is what makes this a ban rather than a ratchet.

import { describe, it, expect } from "vitest"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"

const INBOX = join(process.cwd(), "docs", "overnight", "inbox")
const ARCHIVE = join(INBOX, "archive")

/** The day the append-only rule was measured and written into focus.md. */
const RULE_DATE = "2026-08-17"

/** Filings are named `<ISO-date>T<hhmm>Z-<slug>.md`; undated files are ignored. */
const DATED = /^(\d{4}-\d{2}-\d{2})T\d{4}Z/

describe("docs/overnight/inbox is append-only since the rule", () => {
  const archived = existsSync(ARCHIVE)
    ? readdirSync(ARCHIVE).filter((f) => f.endsWith(".md"))
    : []

  it("inspected a real archive — a broken walk must not read as compliance", () => {
    // The historical archive is large; if this ever reads near zero the walk is
    // wrong, not the repo suddenly clean.
    expect(archived.length, "archive/ looks empty — is the path right?").toBeGreaterThan(100)
  })

  it("POSITIVE CONTROL — the cutoff actually classifies", () => {
    // Without this, a broken date regex would classify everything as "not dated"
    // and the ban below would assert nothing while reading as a clean pass.
    //
    // ⚠ 70 is a floor UNDER A MEASUREMENT, not a guess: 77 of the 275 archived
    // files carry the `<date>T<hhmm>Z` shape (2026-08-23) — the rest predate that
    // naming. My first draft asserted `> 100` from intuition and reddened on
    // correct code, which is the same "a cost stated with no number in it" shape
    // this repo keeps recording, committed by the person writing the guard.
    //
    // ⚠ It cannot drift upward either: growing it would require archiving more
    // dated files, which the ban below forbids.
    const before = archived.filter((f) => {
      const m = f.match(DATED)
      return m !== null && m[1] < RULE_DATE
    })
    expect(before.length, "no archived file parsed as pre-rule — the date regex is wrong").toBeGreaterThan(70)
  })

  it("BAN: no filing dated on or after the rule may sit in archive/", () => {
    const offenders = archived
      .filter((f) => {
        const m = f.match(DATED)
        return m ? m[1] >= RULE_DATE : false
      })
      .sort()

    expect(
      offenders,
      "These filings were archived after docs/overnight/focus.md made inbox/ append-only.\n" +
        "Inbox filings are permanent citation targets — the ledger, handoffs, the roadmap,\n" +
        "committed migrations and live product source reference them by exact path, and a\n" +
        "migration is immutable history that must not be edited to chase a move.\n" +
        "`git mv` them back to docs/overnight/inbox/. If the directory's size is the problem,\n" +
        "the fix is a stub or an index, never a move.\n" +
        offenders.map((f) => `  ${f}`).join("\n"),
    ).toEqual([])
  })
})
