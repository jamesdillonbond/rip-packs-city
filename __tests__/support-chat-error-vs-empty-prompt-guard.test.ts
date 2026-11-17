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

// ── PER-HANDLER, not just per-FILE ──────────────────────────────────────────
//
// ⚠ The "the tools really do emit status:error" case below counts occurrences
// across the WHOLE 3,996-line file, so it is satisfied by any 33 of them. A
// 34th tool could ship able to say `no_results` and nothing else, and that
// global check would still pass — the guard-scope shape this repo keeps paying
// for, met here on a count instead of a directory walk.
//
// Measured 2026-08-16: 33 handlers, and EVERY one that can return `no_results`
// also carries an error path. So this pins a property that currently holds
// rather than fixing a defect — which is the point. The prompt rule tells the
// model the two statuses mean different things; that instruction is worthless
// for any tool physically incapable of producing the first one.

/** Split executeTool into its per-tool `if (toolName === "x")` blocks. */
function toolHandlers(): Array<{ name: string; body: string }> {
  const starts = [...SRC.matchAll(/if \(toolName === "([a-z_]+)"\)/g)]
  return starts.map((m, i) => ({
    name: m[1],
    body: SRC.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : SRC.length),
  }))
}

describe("every concierge tool that can say 'nothing' can also say 'I could not look'", () => {
  const handlers = toolHandlers()

  it("finds the handler blocks (not vacuously passing)", () => {
    // ⚠ Asserts the PARSE works, not that many handlers are dirty — a threshold
    // on a defect count goes red the moment the population reaches zero, which
    // this repo shipped once already in server-page-data-access-ratchet.
    expect(handlers.length, "executeTool must still be a toolName ladder").toBeGreaterThan(25)
    expect(handlers.map((h) => h.name)).toContain("get_fmv")
  })

  it("no handler can return no_results without an error path of its own", () => {
    const offenders = handlers
      .filter((h) => h.body.includes('status: "no_results"') && !h.body.includes('status: "error"'))
      .map((h) => h.name)
    expect(
      offenders,
      `These tools can tell the model "nothing matched" but have no way to say the lookup FAILED,\n` +
        `so the prompt's error-vs-empty rule is unreachable for them and an outage renders as a finding:\n` +
        offenders.map((n) => `  - ${n}`).join("\n"),
    ).toEqual([])
  })

  it("every handler that READS can report a failure", () => {
    // ⚠ `escalate_to_human` is the one legitimate exception and is asserted
    // separately below: it does not return `status: "error"` because its whole
    // contract is a delivery report, and it carries a stricter honesty property
    // than the generic one.
    const reading = handlers.filter((h) =>
      /await (?:\(supabase as any\)|supabase)\.|await fetchAllPaged|await fetch\(/.test(h.body),
    )
    const silent = reading
      .filter((h) => !h.body.includes('status: "error"') && h.name !== "escalate_to_human")
      .map((h) => h.name)
    expect(silent, "a tool that reads must be able to report a failed read").toEqual([])
  })

  it("escalate_to_human never reports a page it did not deliver", () => {
    // ⚠ The highest-stakes honesty claim in the file, and the inverse of every
    // other one here: not "we found nothing" but "we DID something". Telling a
    // user with a live emergency "the team has been paged" when both channels
    // refused makes the failure invisible to BOTH sides — they stop escalating
    // and nobody was told.
    const h = toolHandlers().find((x) => x.name === "escalate_to_human")!
    expect(h.body, "delivery must be tracked, not assumed").toContain("let pageDelivered = false")
    // Set ONLY inside the 2xx branch of each channel — a dead token resolves a
    // response object, so `await fetch(...)` succeeding proves nothing.
    expect((h.body.match(/if \(res\.ok\) pageDelivered = true;/g) ?? []).length).toBe(2)
    // The confirmation copy must be gated on it...
    expect(h.body).toContain("paged: pageDelivered")
    expect(h.body).toMatch(/pageDelivered\s*\n?\s*\?\s*"The team has been paged/)
    // ...and an undelivered HIGH page must leave a trace an operator can find,
    // or a broken pager is silent until someone notices they were never called.
    expect(h.body).toContain('p_pipeline: "support-chat-escalation"')
    expect(h.body).toContain("p_ok: false")
  })
})
