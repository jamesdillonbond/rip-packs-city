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
// ⚠ THE LOAD-BEARING CONTRACT IS NOT THAT IT RENDERS. It is that
// **"Our team has been notified" is TRUE.** That sentence is a factual claim
// made to a user about what the system did, and the only thing making it true
// is the `Sentry.captureException(error)` in the effect beside it. Delete or
// break that call and the page keeps telling every user they have been heard
// while nobody has — a false claim about the reader's own situation, and the
// sub-class this repo rates worst, because **an alert's output is silence, so
// its failure is unfalsifiable.** The copy and the capture have to be asserted
// TOGETHER or neither half is pinned.
//
// ⚠ Asserts the ABSENCE of the false claim, not merely the PRESENCE of a call:
// the test below fails if the reassurance is rendered without a capture, which
// is the direction that lies to a user.

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
  it("reports the error to Sentry, so the reassurance it prints is TRUE", () => {
    const error = ERR()
    render(<GlobalError error={error} reset={() => {}} />)

    // The two halves of the same promise, asserted together.
    expect(captureException).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(error)
    expect(screen.getByText(/Our team has been notified/i)).toBeTruthy()
  })

  it("never prints the reassurance without having reported (the false-claim direction)", () => {
    render(<GlobalError error={ERR()} reset={() => {}} />)
    const claimsNotified = /Our team has been notified/i.test(document.body.textContent ?? "")
    // ⚠ Stated as an implication rather than two independent assertions: what
    // must never happen is the CLAIM without the REPORT. Pinning them
    // separately would let a refactor that drops the capture pass by also
    // dropping the sentence — which is a fix, not a regression — while this
    // still holds.
    expect(claimsNotified && captureException.mock.calls.length === 0).toBe(false)
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
