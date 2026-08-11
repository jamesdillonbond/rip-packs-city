// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"

// components/auth/SignOutButton (0% before this). The header identity widget.
// Fetches /api/profile/me on mount, then renders one of three states:
//   - loading skeleton (fetch unresolved),
//   - a "Sign In" link when there is no email,
//   - a "Me" pill with initials + a click-to-open dropdown (email, Profile
//     link, Sign Out) when signed in.
// Drives the initials formatter, the open/close toggle, click-outside close,
// and the Sign Out click → signOut() call.

const signOutMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth/supabase-client", () => ({ signOut: signOutMock }))

import SignOutButton from "@/components/auth/SignOutButton"

let fetchMock: ReturnType<typeof vi.fn>
function meResp(email: string | null, ok = true) {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(email ? { user: { email } } : { user: null }),
  } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
  signOutMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("SignOutButton", () => {
  it("renders the loading skeleton before /api/profile/me resolves", () => {
    fetchMock.mockReturnValue(new Promise(() => {})) // never resolves
    const { container } = render(<SignOutButton />)
    // No Sign In link and no Me pill yet — just the placeholder div.
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).not.toContain("Me")
  })

  it("shows a Sign In link when there is no email", async () => {
    fetchMock.mockReturnValue(meResp(null))
    const { container } = render(<SignOutButton />)
    await waitFor(() => {
      const link = container.querySelector("a")
      expect(link?.getAttribute("href")).toBe("/login")
    })
    expect(container.textContent).toContain("Sign In")
  })

  it("soft-fails to the Sign In link when the fetch is not ok", async () => {
    fetchMock.mockReturnValue(meResp(null, false))
    const { container } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Sign In"))
  })

  it("soft-fails to the Sign In link when the fetch rejects", async () => {
    fetchMock.mockReturnValue(Promise.reject(new Error("boom")))
    const { container } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Sign In"))
  })

  it("renders a Me pill with two-letter initials from a dotted local part", async () => {
    fetchMock.mockReturnValue(meResp("jane.doe@example.com"))
    const { container } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    // parts ["jane","doe"] → "JD"
    expect(container.textContent).toContain("JD")
  })

  it("falls back to the first two chars when the local part has no separator", async () => {
    fetchMock.mockReturnValue(meResp("trevor@example.com"))
    const { container } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    // no [._-] → "trevor".slice(0,2).toUpperCase() = "TR"
    expect(container.textContent).toContain("TR")
  })

  it("opens the dropdown on click, showing the email, Profile link, and Sign Out", async () => {
    fetchMock.mockReturnValue(meResp("owner@example.com"))
    const { container, getByRole, getByText } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    // Dropdown not present yet.
    expect(container.querySelector('[role="menu"]')).toBeNull()
    fireEvent.click(getByRole("button"))
    const menu = container.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toContain("owner@example.com")
    expect(getByText("Profile").getAttribute("href")).toBe("/dashboard")
    expect(getByText("Sign Out")).toBeTruthy()
  })

  it("calls signOut() when Sign Out is clicked", async () => {
    fetchMock.mockReturnValue(meResp("owner@example.com"))
    const { container, getByRole, getByText } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    fireEvent.click(getByRole("button"))
    fireEvent.click(getByText("Sign Out"))
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it("closes the dropdown on a click outside the widget", async () => {
    fetchMock.mockReturnValue(meResp("owner@example.com"))
    const { container, getByRole } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    fireEvent.click(getByRole("button"))
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    // mousedown on the document body (outside rootRef) closes it.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeNull())
  })

  it("clicking the Profile link closes the dropdown", async () => {
    fetchMock.mockReturnValue(meResp("owner@example.com"))
    const { container, getByRole, getByText } = render(<SignOutButton />)
    await waitFor(() => expect(container.textContent).toContain("Me"))
    fireEvent.click(getByRole("button"))
    fireEvent.click(getByText("Profile"))
    await waitFor(() => expect(container.querySelector('[role="menu"]')).toBeNull())
  })
})
