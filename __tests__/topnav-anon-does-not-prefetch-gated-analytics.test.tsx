// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// 2026-10-04: an anonymous crawl of the public site saw a 307 → /login on every page
// load — Next's viewport prefetch of the top-nav "Analytics" link, a sign-in-only area.
// The first fix suppressed the prefetch for anon while keeping the link visible.
// 2026-10-11 (platform review M7): the link itself is signed-in only now — a visible
// link that 307s on click was the same dead end one step later. So the property this
// file pins became stricter: anon renders NO /analytics link at all (nothing to
// prefetch), and a signed-in user keeps the link with the default prefetch.
// next/link is mocked to expose the prop.

vi.mock("next/navigation", () => ({ usePathname: () => "/" }))
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: React.ReactNode }) => (
    <a href={href} data-prefetch={prefetch === undefined ? "default" : String(prefetch)} {...rest}>{children}</a>
  ),
}))
const authState = vi.hoisted(() => ({ user: null as unknown }))
vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseBrowser: () => ({
    auth: {
      getUser: () => Promise.resolve({ data: { user: authState.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  }),
}))

import TopNav from "@/components/TopNav"

const prefetchOf = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll("a")).find((a) => a.textContent === label)?.getAttribute("data-prefetch")

afterEach(() => cleanup())

describe("TopNav — menu links are not preloaded on every page view", () => {
  // 2026-10-25: /analytics became public and was shown to everyone but not
  // prefetched for anon. IA Phase 2 (2026-11-06) generalises the rule: the
  // header now carries ~40 menu links on every page, so NO menu item is
  // prefetched for anyone; the six group hubs (a handful) keep Next's default.
  it("anon: no menu item is prefetched; group hubs keep the default", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(prefetchOf(container, "Analytics")).toBe("false")
    expect(prefetchOf(container, "Blog")).toBe("false")
    const menuItems = Array.from(container.querySelectorAll('[role="menuitem"]'))
    expect(menuItems.length).toBeGreaterThan(20)
    expect(menuItems.filter((a) => a.getAttribute("data-prefetch") !== "false")).toEqual([])
    const hub = container.querySelector('a[data-ia-group="market"]')!
    expect(hub.getAttribute("data-prefetch")).toBe("default")
  })

  it("signed in: still no menu-item prefetch (the gated ones included)", async () => {
    authState.user = { id: "u1" }
    const { container } = render(<TopNav />)
    await waitFor(() => expect(prefetchOf(container, "Alerts")).toBe("false"))
    expect(prefetchOf(container, "Analytics")).toBe("false")
  })
})
