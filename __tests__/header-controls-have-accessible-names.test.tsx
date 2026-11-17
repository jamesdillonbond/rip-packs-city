// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// Every control in the site-wide header has an accessible name (platform
// review 2026-10-11, C10). TopNav.tsx and GlobalSiteHeader.tsx themselves
// contain no icon-only <button> — the icon-only control the header mounts is
// ThemeToggle's 30×30 sun/moon button, and the logo link's text is
// display:none under 480 px, where its name comes from the <img alt>. This
// renders the REAL children (component-GlobalSiteHeader.test.tsx stubs them)
// so a refactor that drops the aria-label, the alt, or the "Sign In" text
// reds here instead of shipping an unnamed control to every page.

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  }),
  signOut: vi.fn(),
}))

import GlobalSiteHeader from "@/components/GlobalSiteHeader"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A deliberately simple accessible-name computation: aria-label, then
 *  aria-labelledby, then the element's text, then an <img alt> inside it. */
function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim()
  if (label) return label
  const by = el.getAttribute("aria-labelledby")
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim()
    if (text) return text
  }
  const text = el.textContent?.trim() ?? ""
  if (text) return text
  const alt = Array.from(el.querySelectorAll("img")).map((i) => i.getAttribute("alt")?.trim() ?? "").find(Boolean)
  return alt ?? ""
}

describe("GlobalSiteHeader — every control has an accessible name", () => {
  it("buttons, links and inputs are all named for assistive tech (anonymous visitor)", async () => {
    // SignOutButton fetches /api/profile/me on mount; anon → not ok → "Sign In".
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const { container } = render(<GlobalSiteHeader />)
    await screen.findByText(/sign in/i)

    const controls = Array.from(container.querySelectorAll("button, a, input"))
    expect(controls.length, "the header renders controls").toBeGreaterThan(3)
    const unnamed = controls
      .filter((el) => accessibleName(el) === "")
      .map((el) => `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}">`)
    expect(unnamed, "these header controls have NO accessible name").toEqual([])
  })

  it("the icon-only theme toggle is named by aria-label, not by text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const { container } = render(<GlobalSiteHeader />)
    await screen.findByText(/sign in/i)
    const iconOnly = Array.from(container.querySelectorAll("button")).filter((b) => (b.textContent?.trim() ?? "") === "")
    expect(iconOnly.length, "the header has exactly one icon-only button (ThemeToggle)").toBe(1)
    expect(iconOnly[0].getAttribute("aria-label")).toMatch(/switch to (light|dark) mode/i)
    // Its SVG is decorative and must stay out of the name.
    expect(iconOnly[0].querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  })

  it("the logo link keeps a name when its text label is hidden on a phone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })))
    const { container } = render(<GlobalSiteHeader />)
    await screen.findByText(/sign in/i)
    const home = Array.from(container.querySelectorAll("a")).find((a) => a.getAttribute("href") === "/")!
    expect(home).toBeTruthy()
    // .rpc-gsh-label is display:none under 480 px and at md, which removes it
    // from the accessible name — the <img alt> is what names the link there.
    expect(home.querySelector("img")?.getAttribute("alt")).toMatch(/rip packs city/i)
  })
})
