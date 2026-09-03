// @vitest-environment jsdom
//
// __tests__/component-LoginClient.test.tsx
//
// The sign-in form: the single entry to every collection tool, and the page
// AuthConfirmClient bounces to on every failure — so the two suites are halves
// of one contract. AuthConfirmClient pins WHICH error code it forwards; this
// one pins that /login turns each of those codes into something a person can
// act on rather than a raw token echoed onto the screen.
//
// ⚠ THE THREE-STATE SPLIT IS THE WHOLE POINT OF THE FORM. `sendMagicLink`
// returns three distinct outcomes and they must NEVER share a branch:
//   ok                -> "check your email"  (we sent it)
//   notOnAllowList    -> the blocked card    (we deliberately did not send it)
//   error             -> the inline error    (we tried and failed)
// Collapsing the second into the third tells a deny-listed user to retry
// forever; collapsing the third into the second tells someone whose signup is
// perfectly valid that they are banned.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, within, fireEvent } from "@testing-library/react"

let searchParams = new URLSearchParams()
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}))

const sendMagicLink = vi.fn()
vi.mock("@/lib/auth/supabase-client", () => ({
  sendMagicLink: (...args: unknown[]) => sendMagicLink(...args),
}))

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import LoginClient from "@/app/login/LoginClient"

/** Mount with a given query string, the only input this component takes. */
function renderAt(query = "") {
  searchParams = new URLSearchParams(query)
  return render(<LoginClient />)
}

const emailBox = () => screen.getByPlaceholderText("you@example.com") as HTMLInputElement
const submit = () => screen.getByRole("button", { name: /send magic link/i })

beforeEach(() => {
  sendMagicLink.mockReset()
  sendMagicLink.mockResolvedValue({ ok: true, error: null })
})

afterEach(() => cleanup())

describe("LoginClient — the redirect target", () => {
  it("prefers `next` (what proxy.ts emits) over the legacy `redirect`", async () => {
    renderAt("next=/dashboard/alerts&redirect=/old")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    await waitFor(() => expect(sendMagicLink).toHaveBeenCalled())
    expect(sendMagicLink).toHaveBeenCalledWith("a@b.com", "/dashboard/alerts")
  })

  it("falls back to the legacy `redirect` when `next` is absent", async () => {
    // Older links and the magic-link callback chain still use `redirect`, so
    // dropping this fallback silently strands anyone arriving from one.
    renderAt("redirect=/nba-top-shot/sniper")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    await waitFor(() => expect(sendMagicLink).toHaveBeenCalledWith("a@b.com", "/nba-top-shot/sniper"))
  })

  it("defaults to /dashboard when neither is present", async () => {
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    await waitFor(() => expect(sendMagicLink).toHaveBeenCalledWith("a@b.com", "/dashboard"))
  })
})

describe("LoginClient — the email is normalised before it leaves the page", () => {
  it("trims and lowercases, so a stray space or capital cannot mismatch the allow-list", async () => {
    // ⚠ NOT COSMETIC. The server-side gate matches on the stored email, so
    // "  A@B.COM " and "a@b.com" are the same person to a human and two
    // different rows to a lookup. Losing this makes a deny-list entry evadable
    // AND makes a legitimate user look unrecognised.
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "  A@B.CoM  " } })
    fireEvent.click(submit())

    await waitFor(() => expect(sendMagicLink).toHaveBeenCalledWith("a@b.com", "/dashboard"))
  })

  it("does not submit a whitespace-only email — the HANDLER guards, not just the button", async () => {
    // ⚠ SUBMITS THE FORM, NOT THE BUTTON, AND THAT IS THE POINT. Clicking the
    // disabled button proves only that `disabled` is set; the click never
    // reaches `handleSubmit`, so the assertion would hold with the handler's
    // own `if (!email.trim()) return` deleted. A form submits on Enter and via
    // any programmatic path regardless of the button's state, so the guard is
    // load-bearing and needs its own case.
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "   " } })
    fireEvent.submit(emailBox().closest("form")!)

    expect(sendMagicLink).not.toHaveBeenCalled()
  })

  it("disables submit until something is typed", () => {
    renderAt("")
    expect((submit() as HTMLButtonElement).disabled).toBe(true)
  })
})

describe("LoginClient — the three outcomes stay three", () => {
  it("ok renders 'check your email' NAMING the address it went to", async () => {
    // Echoing the address back is what lets a user catch their own typo — the
    // most common reason a magic link "never arrives".
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "typo@gmial.com" } })
    fireEvent.click(submit())

    expect(await screen.findByText(/check your email/i)).toBeTruthy()
    expect(screen.getByText("typo@gmial.com")).toBeTruthy()
  })

  it("notOnAllowList renders the BLOCKED card, never the inline error", async () => {
    sendMagicLink.mockResolvedValue({
      ok: false,
      notOnAllowList: true,
      error: "You're on the waitlist — request access at /early-access.",
    })
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "blocked@b.com" } })
    fireEvent.click(submit())

    expect(await screen.findByText(/Can't sign in with that email/i)).toBeTruthy()
    // ⚠ The blocked card explains that retrying will not help and points at a
    // human. The inline error implies "try again", which for a deny-listed
    // address is an instruction to do something that can never work.
    expect(screen.queryByText(/Something went wrong/i)).toBeNull()
    expect(screen.getByRole("button", { name: /try a different email/i })).toBeTruthy()
  })

  it("a plain failure renders the inline error, never the blocked card", async () => {
    sendMagicLink.mockResolvedValue({ ok: false, error: "Sign-in service is temporarily unavailable." })
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    expect(await screen.findByText(/temporarily unavailable/i)).toBeTruthy()
    expect(screen.queryByText(/Can't sign in with that email/i)).toBeNull()
    // The form is still there to retry with, which is the correct affordance
    // for a transient failure.
    expect(emailBox()).toBeTruthy()
  })

  it("an empty error string still shows SOMETHING rather than a blank red box", async () => {
    // A failure that renders no text is indistinguishable from success that
    // rendered nothing — the user is left staring at an unchanged form.
    sendMagicLink.mockResolvedValue({ ok: false, error: "   " })
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    expect(await screen.findByText(/Something went wrong — please try again\./i)).toBeTruthy()
  })

  it("shows a sending state while in flight and does not double-submit", async () => {
    let release: (v: unknown) => void = () => {}
    sendMagicLink.mockImplementation(() => new Promise((r) => (release = r)))
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    expect(await screen.findByRole("button", { name: /sending link/i })).toBeTruthy()
    expect(emailBox().disabled).toBe(true)
    release({ ok: true, error: null })
    await waitFor(() => expect(screen.getByText(/check your email/i)).toBeTruthy())
    expect(sendMagicLink).toHaveBeenCalledTimes(1)
  })
})

describe("LoginClient — 'use a different email' returns to a usable form", () => {
  it("clears the sent state AND the typed address", async () => {
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "first@b.com" } })
    fireEvent.click(submit())
    await screen.findByText(/check your email/i)

    fireEvent.click(screen.getByRole("button", { name: /use a different email/i }))

    // Leaving the old address in the box is how a user re-sends to the very
    // address that just failed them.
    expect(emailBox().value).toBe("")
    expect(screen.queryByText(/check your email/i)).toBeNull()
  })

  it("the blocked card's reset also clears the address", async () => {
    sendMagicLink.mockResolvedValue({ ok: false, notOnAllowList: true, error: "x" })
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "blocked@b.com" } })
    fireEvent.click(submit())
    await screen.findByText(/Can't sign in with that email/i)

    fireEvent.click(screen.getByRole("button", { name: /try a different email/i }))
    expect(emailBox().value).toBe("")
  })
})

describe("LoginClient — errors arriving in the URL from proxy.ts and /auth/confirm", () => {
  it("access_revoked renders the dedicated banner, not the inline error", async () => {
    renderAt("error=access_revoked")

    expect(screen.getByText(/Access unavailable/i)).toBeTruthy()
    expect(screen.getByText(/access has been removed/i)).toBeTruthy()
    // ⚠ The banner sits ABOVE the form and survives a resubmit; the inline
    // error is cleared on submit. Rendering this as an inline error would make
    // the explanation vanish the moment the user tries again — exactly when
    // they most need it.
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy()
  })

  it("the access_revoked banner SURVIVES a resubmit", async () => {
    sendMagicLink.mockResolvedValue({ ok: false, error: "nope" })
    renderAt("error=access_revoked")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    await screen.findByText(/nope/i)
    expect(screen.getByText(/Access unavailable/i)).toBeTruthy()
  })

  it("allowlist_unavailable is translated, never echoed as a raw code", async () => {
    // proxy.ts fails CLOSED to this when the allow-list RPC itself is down.
    // The raw token means nothing to a user and reads like a rejection, when
    // the truth is "our gate is down, try again".
    renderAt("error=allowlist_unavailable")

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    expect(screen.queryByText("allowlist_unavailable")).toBeNull()
  })

  it("forwards an /auth/confirm failure into the inline error — as COPY, not the code", async () => {
    // ⚠ INVERTED 2026-09-03. This asserted `getByText("session_failed")`, i.e.
    // it PINNED the raw slug reaching the user — the sibling case directly above
    // had been asserting the opposite property for `allowlist_unavailable` since
    // it was written. The PROPERTY this case is named for (a confirm failure
    // reaches the inline error) is unchanged and still asserted; only the
    // spelling moved, so the case is inverted rather than deleted.
    renderAt("error=session_failed")
    expect(screen.getByText(/couldn.t finish signing you in/i)).toBeTruthy()
    expect(screen.queryByText("session_failed")).toBeNull()
  })

  it("an UNKNOWN ?error= value is not rendered — a crafted link is not our voice", async () => {
    // The value is attacker-supplied. Echoing it put arbitrary text inside our
    // own error banner on our own login page: not XSS (React escapes it), but a
    // phishing message wearing our UI, which is worse here.
    renderAt("error=Your+account+was+locked.+Call+555-0100")
    expect(screen.queryByText(/555-0100/)).toBeNull()
    expect(screen.getByText(/something went wrong signing you in/i)).toBeTruthy()
  })

  it("a submit CLEARS a stale URL error DURING the in-flight window", async () => {
    // The URL error describes the PREVIOUS attempt. Leaving it on screen while
    // the new one is in flight tells the user their fresh attempt has already
    // failed, next to a button reading "Sending link…".
    //
    // ⚠ THE IN-FLIGHT STATE IS THE ONLY PLACE THIS IS OBSERVABLE, AND THE FIRST
    // VERSION OF THIS CASE PROVED NOTHING. It asserted the error was gone after
    // a SUCCESSFUL submit — but success swaps the whole form out for the "check
    // your email" card, so the error disappears with or without `setError("")`.
    // The mutation survived. A never-resolving request holds the form on screen,
    // which is the state a real user actually sees.
    let release: (v: unknown) => void = () => {}
    sendMagicLink.mockImplementation(() => new Promise((r) => (release = r)))
    renderAt("error=session_failed")
    expect(screen.getByText(/couldn.t finish signing you in/i)).toBeTruthy()

    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.click(submit())

    // The form is still mounted (proving the assertion below is about the
    // error being CLEARED, not about the form being unmounted).
    expect(await screen.findByRole("button", { name: /sending link/i })).toBeTruthy()
    expect(screen.queryByText("session_failed")).toBeNull()
    release({ ok: true, error: null })
    await screen.findByText(/check your email/i)
  })
})

describe("LoginClient — the anonymous escape hatches", () => {
  it("offers /insights without an account, in both places", () => {
    renderAt("")
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
    expect(hrefs.filter((h) => h === "/insights").length).toBeGreaterThanOrEqual(2)
  })

  it("links privacy and terms from the footer", () => {
    renderAt("")
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/privacy")
    expect(hrefs).toContain("/terms")
  })

  it("the primary CTA has a hover affordance, and it returns to rest", () => {
    // Presentational, but it is the only interactive feedback on the one button
    // this page exists for, and a handler that brightens without a matching
    // handler that dims leaves the button stuck lit after the pointer leaves.
    //
    // ⚠ `fireEvent.mouseOver` / `mouseOut`, NOT `mouseEnter` / `mouseLeave`.
    // React synthesizes onMouseEnter/onMouseLeave from the BUBBLING
    // mouseover/mouseout pair; a native `mouseenter` does not bubble and never
    // reaches the handler, so the enter/leave spelling leaves the style
    // untouched and the assertion fails against perfectly correct code.
    //
    // ⚠ AND THE EMAIL MUST BE TYPED FIRST. The button is `disabled` until the
    // field has content, and React does not deliver mouse events to a disabled
    // element — so on an empty form the style never changes and the assertion
    // fails against correct code, for a reason that has nothing to do with
    // hover.
    renderAt("")
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    const btn = submit() as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    const rest = btn.style.boxShadow
    expect(rest).toBeTruthy() // not vacuous: there IS a resting shadow to differ from
    fireEvent.mouseOver(btn)
    expect(btn.style.boxShadow).not.toBe(rest)
    fireEvent.mouseOut(btn)
    expect(btn.style.boxShadow).toBe(rest)
  })

  it("says signup is free and needs no invite — the front door is OPEN", () => {
    // Self-serve signup opened 2026-07-20. Copy implying a closed beta here
    // turns away users the gate would in fact admit.
    renderAt("")
    const form = screen.getByPlaceholderText("you@example.com").closest("form")!
    expect(within(form).getByText(/no invite needed/i)).toBeTruthy()
  })
})
