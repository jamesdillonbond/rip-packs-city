// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, screen, fireEvent } from "@testing-library/react"

// Drives `app/global-error.tsx` — the app's LAST-RESORT error boundary, and
// until now referenced by zero tests and measured by neither coverage gate.
//
// ── WHY THIS FILE IS WORTH PINNING AT ALL ─────────────────────────────────
// It is the only boundary between an unhandled throw and a white screen: there
// are two error boundaries app-wide, and this is the outer one. An untested
// last-resort boundary is the guard-fails-open shape — if it throws, the thing
// that catches failures has itself failed, and nothing is left to notice.
//
// ⚠ THE LOAD-BEARING CONTRACT IS NOT THAT IT RENDERS. It is that the page never
// makes a claim it cannot keep.
//
// ── 2026-08-26: THIS CONTRACT WAS INVERTED, AND THE REASON IS THE POINT ──────
// It used to pin that **"Our team has been notified" is TRUE**, on the argument
// that the `Sentry.captureException(error)` in the effect beside it is what makes
// it true. That argument was right about the CODE and wrong about the WORLD:
// a test can only observe that the capture is CALLED, never that the report is
// STORED. Sentry stopped storing anything on 2026-08-18 (org error quota
// exhausted, and the operator decision is not to buy more), so for eight days the
// page told every user they had been heard, the capture ran on every one of them,
// and this suite stayed green throughout.
//
// ⭐ **A guard that pins "claim ⇒ call" cannot see the gap between the call and
// the delivery.** The fix is not a better assertion — no assertion reaches that
// far — it is to stop making the claim: the copy now says "We logged it", which is
// ours to promise, instead of "our team has been notified", which depends on a
// third party being up. The old test even anticipated this, noting that dropping
// the sentence "is a fix, not a regression".
//
// ⚠ So the assertions below are INVERTED rather than deleted, per this repo's rule
// that a test which pinned a now-fixed defect keeps its subject: the capture is
// still pinned (we should still report when we can), and the page is now pinned
// NOT to make an unfalsifiable delivery promise.

const captureException = vi.hoisted(() => vi.fn())
vi.mock("@sentry/nextjs", () => ({ captureException }))

const GlobalError = (await import("@/app/global-error")).default

// `global-error` renders its own <html>/<body> — required of a Next global
// error boundary, since it REPLACES the root layout rather than nesting in it.
// React warns about the nesting under jsdom; the warning is expected and says
// nothing about the component, so it is silenced rather than left to look like
// a finding for the next reader.
let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  captureException.mockClear()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  consoleError.mockRestore()
})

const ERR = () => Object.assign(new Error("boom"), { digest: "d1gest" })

describe("app/global-error — the last-resort boundary", () => {
  it("still reports the error, because reporting is worth doing even when delivery is not guaranteed", () => {
    // The capture is NOT the thing that makes a user-facing sentence true — that
    // was the mistake this file used to encode — but it remains the only way the
    // error reaches us at all if the collector recovers. Dropping it should red.
    const error = ERR()
    render(<GlobalError error={error} reset={() => {}} />)
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(error)
  })

  it("does NOT promise the user that a human has been notified", () => {
    // ⚠ THE INVERTED ASSERTION. The truth of "our team has been notified" depends
    // on a third-party collector STORING the event, which nothing in this process
    // — and no test — can observe. Sentry silently dropped everything from
    // 2026-08-18 while `captureException` kept being called, so the page made that
    // claim to every user for eight days with this suite green.
    //
    // Asserted as the ABSENCE of the unfalsifiable claim, and deliberately matched
    // on the PROPERTY (a delivery/notification promise) rather than one spelling,
    // so re-wording it back in under a synonym still reds.
    render(<GlobalError error={ERR()} reset={() => {}} />)
    const text = document.body.textContent ?? ""
    expect(
      /been notified|team (has|have) been|we(?:'| a)?ve been notified|someone (has been|will be) (notified|alerted)/i.test(text),
      "global-error must not tell the user a human has been notified — that depends on a delivery this process cannot observe (Sentry stored nothing for 8 days while the capture kept firing)",
    ).toBe(false)
  })

  it("still says something TRUE and useful about what happened", () => {
    // Not vacuous: the assertion above is satisfiable by rendering nothing at all,
    // so this pins that removing the false claim did not leave the user with a bare
    // heading. "We logged it" is a claim about US and is ours to make.
    render(<GlobalError error={ERR()} reset={() => {}} />)
    expect(screen.getByText(/We logged it/i)).toBeTruthy()
  })

  it("offers a working recovery — reset is wired to the button, not decorative", () => {
    // Without this the user is stranded on a dead page with a button that
    // looks like a way out.
    const reset = vi.fn()
    render(<GlobalError error={ERR()} reset={reset} />)
    fireEvent.click(screen.getByText(/Try Again/i))
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it("reports the error ITSELF, not a re-wrapped copy that loses the digest", () => {
    // Next attaches `digest` to server-thrown errors, and it is the only way to
    // tie a user's report to the server log line. A capture of `new
    // Error(error.message)` would satisfy a call-count assertion and silently
    // drop it.
    const error = ERR()
    render(<GlobalError error={error} reset={() => {}} />)
    const captured = captureException.mock.calls[0][0] as Error & { digest?: string }
    expect(captured).toBe(error)
    expect(captured.digest).toBe("d1gest")
  })

  it("states that something failed rather than rendering a plausible empty page", () => {
    // The honesty canon's three states: this branch is 'the read failed', and
    // it must SAY so. A boundary that rendered an empty shell would look like
    // a page with no content — a failure presented as an answer.
    render(<GlobalError error={ERR()} reset={() => {}} />)
    expect(screen.getByText(/Something went wrong/i)).toBeTruthy()
    expect((document.body.textContent ?? "").trim().length).toBeGreaterThan(20)
  })
})
