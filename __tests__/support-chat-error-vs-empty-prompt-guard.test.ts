import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Source guard for the LAST layer of the "a failed read must not render as an
// answer" class — the one the three-helper map in CLAUDE.md cannot cover.
//
// The other three layers are code: an API route returns a classified error, a
// server page threads an `ok` flag, a client dashboard branches on `res.ok`. The
// concierge is different — its "renderer" is a language model, and what stops it
// presenting a failure as a finding is a RULE IN THE SYSTEM PROMPT, not a branch.
//
// Why this became load-bearing on 2026-08-12: 33 tool sites in support-chat's
// executeTool return `{ status: "error", message: ... }`, and the prompt had an
// explicit rule for `status: "no_results"` ("say so; do not invent a ballpark")
// and NOTHING for `status: "error"`. So the model had no instruction separating
// "I looked and found nothing" from "I could not look" — and the natural,
// fluent completion of an errored deals search is "there are no deals below FMV
// right now", which is a confident claim about the market manufactured from a
// statement timeout. Same defect as the empty board at HTTP 200, one layer up.
//
// A prompt rule has no type and no branch, so nothing but a source assertion can
// notice it being trimmed in a future edit of a 3,000-line file.

const SRC = readFileSync(
  join(process.cwd(), "app", "api", "support-chat", "route.ts"),
  "utf8"
)

describe("concierge system prompt separates a failed tool from an empty one", () => {
  it("carries an explicit status:error rule, not just status:no_results", () => {
    expect(SRC, "the errored-tool rule heading must be present").toContain(
      "An errored tool is NOT an empty result"
    )
    // The rule is only useful if it names the shape the tools actually emit.
    expect(SRC, "the rule must name the status:error shape the tools return").toMatch(
      /"status":\s*"error"/
    )
    // ...and it must forbid the specific substitution, not just gesture at care.
    expect(SRC, "the rule must forbid converting an error into a zero/none claim").toMatch(
      /does NOT mean the answer is zero, none, or nothing/
    )
  })

  it("keeps the no_results rule, which is the case that IS a finding", () => {
    // If a future edit collapses the two cases into one rule, the distinction
    // this guard exists to protect is gone even though the heading survives.
    expect(SRC, 'the "no_results" rule must still exist separately').toContain(
      'status = "no_results"'
    )
    expect(SRC, "the prompt must state that no_results is the opposite case").toContain(
      'is the opposite case'
    )
  })

  it("the tools really do emit the status:error shape the rule describes", () => {
    // Guards against the rule outliving the shape. If executeTool stopped
    // emitting `status: "error"`, the prompt rule would be describing something
    // that no longer happens, and a NEW unhandled failure shape would be live.
    const sites = SRC.match(/status:\s*"error"/g) ?? []
    expect(
      sites.length,
      "support-chat should still return status:error tool results"
    ).toBeGreaterThan(20)
  })

  it("errored tool results publish classified copy, never a driver message", () => {
    // The prompt tells the model the message is safe to relay verbatim. That is
    // only true while these sites go through safeApiError — before 2026-08-12
    // they were raw `err.message`, i.e. Postgres's own wording, which the model
    // could then quote to a visitor.
    expect(SRC, "support-chat must classify errors before returning them").toContain(
      'from "@/lib/api-error"'
    )
    const rawLeaks = (SRC.match(/status:\s*"error",\s*message:\s*[A-Za-z_$][\w$]*\??\.message/g) ?? [])
    expect(
      rawLeaks,
      "these tool results hand the driver's own message to the model: " + rawLeaks.join(", ")
    ).toEqual([])
  })
})
