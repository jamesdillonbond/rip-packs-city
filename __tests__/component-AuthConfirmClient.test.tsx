// @vitest-environment jsdom
//
// __tests__/component-AuthConfirmClient.test.tsx
//
// The magic-link landing page. Every branch here ends in a redirect that
// decides whether a real person gets into the product, and the page ships NO
// visible failure state of its own — it bounces to /login carrying an `error`
// and a `description`, and /login renders those. So a defect here is silent on
// this screen by construction: the only observable is WHERE it sent the user
// and WHAT it told the next page.
//
// ⚠ WHY THE TOKENS ARE IN THE HASH AND WHY THAT MATTERS FOR THE TEST. Browsers
// do not transmit URL fragments to the server, so this whole flow is
// client-only and `window.location.hash` is the sole input. Every case here
// drives it by setting the hash, which is exactly how Supabase delivers it.
//
// ⚠ A NOTE ON `/api/profile/touch`. It is fire-and-forget by design — a failed
// touch must NOT block the sign-in, because the session cookie is already
// written by then and bouncing the user to /login at that point would strand
// someone who is, in fact, signed in. Two cases below pin that: a non-2xx and a
// thrown fetch must both still land on "/".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup } from "@testing-library/react"

const replace = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}))

const setSession = vi.fn()
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({ auth: { setSession } }),
}))

const trackFunnelEvent = vi.fn()
vi.mock("@/lib/track-funnel", () => ({
  trackFunnelEvent: (...args: unknown[]) => trackFunnelEvent(...args),
}))

import AuthConfirmClient from "@/app/auth/confirm/AuthConfirmClient"

/** Set the fragment exactly as Supabase delivers it. */
function setHash(hash: string) {
  window.location.hash = hash
}

/** Parse the single argument handed to router.replace into path + params. */
function lastRedirect(): { path: string; params: URLSearchParams } {
  expect(replace).toHaveBeenCalled()
  const target = String(replace.mock.calls[replace.mock.calls.length - 1][0])
  const [path, query = ""] = target.split("?")
  return { path, params: new URLSearchParams(query) }
}

let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  replace.mockReset()
  setSession.mockReset()
  trackFunnelEvent.mockReset()
  setSession.mockResolvedValue({ error: null })
  fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    text: async () => "",
  }))
  vi.stubGlobal("fetch", fetchMock)
  // The page console.warns on a failed touch by design; keep the run readable.
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  setHash("")
})

afterEach(() => {
  cleanup()
  warnSpy.mockRestore()
  vi.unstubAllGlobals()
})

describe("AuthConfirmClient — the happy path", () => {
  it("sets the session from the hash tokens and redirects to /", async () => {
    setHash("#access_token=at-123&refresh_token=rt-456&type=magiclink")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    expect(setSession).toHaveBeenCalledWith({
      access_token: "at-123",
      refresh_token: "rt-456",
    })
  })

  it("passes the access token as a Bearer header to /api/profile/touch", async () => {
    // ⚠ NOT DECORATION. setSession() writes the auth cookies, but the immediate
    // touch can race that write, so the token is ALSO sent as a header and the
    // server validates it directly. Dropping the header would leave the touch
    // silently unauthenticated on exactly the requests that race — i.e. it
    // would fail intermittently and only in production.
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("/api/profile/touch")
    expect((init as RequestInit).method).toBe("POST")
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer at-123")
    expect((init as RequestInit).credentials).toBe("include")
  })

  it("reports the completed sign-in to the funnel, tagged with this surface", async () => {
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(trackFunnelEvent).toHaveBeenCalled())
    expect(trackFunnelEvent).toHaveBeenCalledWith({
      eventType: "account_created",
      surface: "auth_confirm",
    })
  })

  it("shows the signed-in message once the session is set", async () => {
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    expect(await screen.findByText(/Signed in\. Redirecting/i)).toBeTruthy()
  })

  it("renders the in-progress message before anything resolves", () => {
    // Deliberately never resolves, so the first paint is observable.
    setSession.mockImplementation(() => new Promise(() => {}))
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    expect(screen.getByText(/Signing you in/i)).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe("AuthConfirmClient — a failed touch must not cost the user their sign-in", () => {
  it("still redirects to / when the touch returns a non-2xx", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" })
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    // The session was set, so the user IS signed in — bouncing them to /login
    // here would strand a signed-in user on the sign-in page.
    expect(lastRedirect().path).toBe("/")
  })

  it("still redirects to / when the touch fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("offline"))
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
  })

  it("still redirects when reading the failed touch's BODY itself fails", async () => {
    // ⚠ The `.text()` here exists only to put a detail in the log, and a diagnostic
    // read must never break the flow it is diagnosing — but the MECHANISM is not the
    // one this comment originally gave, and the correction is the useful part.
    //
    // It said an unguarded reject "would escape into the outer catch". It would not:
    // the `.text()` call sits INSIDE the `try { … } catch (touchErr)` that already
    // wraps the whole touch block, so that catch takes it first. Measured by mutation
    // against this exact file — dropping `.catch(() => "")` ALONE leaves every case
    // here green; dropping it AND the surrounding catch is what reds them.
    //
    // So `.catch(() => "")` is redundant behind another guard in the same statement,
    // and this case is a COMPOSITE assertion ("a touch failure of any shape still
    // signs the user in") rather than a pin on that clause. It stays because the
    // composite is what matters, and the clause becomes load-bearing again the moment
    // the surrounding catch narrows to a specific error type or the `.text()` read
    // moves outside the try — both plausible future edits.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error("body stream already read")
      },
    })
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
  })

  it("logs a non-Error touch throw without crashing", async () => {
    fetchMock.mockRejectedValue("a bare string, not an Error")
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"))
    expect(warnSpy).toHaveBeenCalled()
  })

  it("still reports the funnel event when the touch failed", async () => {
    // The touch is instrumentation for last_active_at; the funnel event is the
    // record that a magic link was successfully clicked. One failing must not
    // suppress the other, or a touch outage silently zeroes the signup metric.
    fetchMock.mockRejectedValue(new Error("offline"))
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(trackFunnelEvent).toHaveBeenCalled())
  })
})

describe("AuthConfirmClient — the failure paths tell /login WHICH failure it was", () => {
  it("an empty hash is missing_token, not a generic failure", async () => {
    setHash("")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { path, params } = lastRedirect()
    expect(path).toBe("/login")
    expect(params.get("error")).toBe("missing_token")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("Supabase's own error is forwarded as auth_failed WITH its description", async () => {
    // ⚠ The description is the only thing that distinguishes "your link
    // expired" from "we are broken", and the user reads it on /login. Dropping
    // it turns every expired link into an unexplained failure.
    setHash("#error=access_denied&error_description=Email+link+is+invalid+or+has+expired")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { path, params } = lastRedirect()
    expect(path).toBe("/login")
    expect(params.get("error")).toBe("auth_failed")
    expect(params.get("description")).toBe("Email link is invalid or has expired")
  })

  it("falls back to the bare error code when no description is supplied", async () => {
    setHash("#error=access_denied")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { params } = lastRedirect()
    expect(params.get("error")).toBe("auth_failed")
    expect(params.get("description")).toBe("access_denied")
  })

  it("a HALF-complete link is session_failed, distinct from missing_token", async () => {
    // Access token but no refresh token. This is NOT "no token at all" — the
    // link was real and partially delivered, which is a different diagnosis and
    // must not be collapsed into the empty-hash case.
    setHash("#access_token=at-123")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { params } = lastRedirect()
    expect(params.get("error")).toBe("session_failed")
    expect(params.get("description")).toMatch(/both tokens/i)
    expect(setSession).not.toHaveBeenCalled()
  })

  it("a refresh token with no access token is also session_failed", async () => {
    setHash("#refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(lastRedirect().params.get("error")).toBe("session_failed")
  })

  it("a setSession error is forwarded with its message", async () => {
    setSession.mockResolvedValue({ error: { message: "Invalid refresh token" } })
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { path, params } = lastRedirect()
    expect(path).toBe("/login")
    expect(params.get("error")).toBe("session_failed")
    expect(params.get("description")).toBe("Invalid refresh token")
    // The sign-in did not happen, so the funnel must not record one.
    expect(trackFunnelEvent).not.toHaveBeenCalled()
  })

  it("a THROWN setSession is caught and reported rather than white-screening", async () => {
    setSession.mockRejectedValue(new Error("network down"))
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const { params } = lastRedirect()
    expect(params.get("error")).toBe("session_failed")
    expect(params.get("description")).toBe("network down")
  })

  it("a non-Error throw still produces a description rather than 'undefined'", async () => {
    setSession.mockRejectedValue("just a string")
    setHash("#access_token=at-123&refresh_token=rt-456")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(lastRedirect().params.get("description")).toBe("Unknown error")
  })
})

describe("AuthConfirmClient — hash parsing details that have bitten before", () => {
  it("tolerates a hash with no leading '#'", async () => {
    // Supabase sends `#a=b`, but `window.location.hash` is normalised by the
    // browser and some clients strip it. Handling both is why the code slices
    // conditionally rather than unconditionally.
    Object.defineProperty(window, "location", {
      value: { ...window.location, hash: "access_token=at-1&refresh_token=rt-2", origin: "https://www.rippackscity.com" },
      writable: true,
    })
    render(<AuthConfirmClient />)

    await waitFor(() => expect(setSession).toHaveBeenCalled())
    expect(setSession).toHaveBeenCalledWith({ access_token: "at-1", refresh_token: "rt-2" })
  })

  it("redirects with a PATH, never an absolute URL carrying the tokens", async () => {
    // ⚠ The tokens live in the fragment of the CURRENT url. Redirecting to an
    // absolute URL built from window.location risks carrying credentials into
    // history and into any downstream logger; the page builds a URL only to
    // compose the query and then hands router.replace `pathname + search`.
    setHash("#error=access_denied&error_description=nope")
    render(<AuthConfirmClient />)

    await waitFor(() => expect(replace).toHaveBeenCalled())
    const target = String(replace.mock.calls[0][0])
    expect(target.startsWith("/login")).toBe(true)
    expect(target).not.toMatch(/^https?:/)
    expect(target).not.toContain("access_token")
  })
})
