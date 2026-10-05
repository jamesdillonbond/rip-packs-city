// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// 2026-10-04: an anonymous crawl of the public site saw a 307 → /login on every page
// load — Next's viewport prefetch of the top-nav "Analytics" link, a sign-in-only area.
// The link stays visible (it is the way in), but a signed-out visitor must not preload
// it; a signed-in one keeps the default prefetch. next/link is mocked to expose the prop.

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

describe("TopNav — a signed-out visitor does not preload sign-in-only pages", () => {
  it("anon: Analytics is shown but not prefetched; public links keep the default", async () => {
    authState.user = null
    const { container } = render(<TopNav />)
    await waitFor(() => {})
    expect(prefetchOf(container, "Analytics")).toBe("false")
    expect(prefetchOf(container, "Blog")).toBe("default")
  })

  it("signed in: Analytics keeps the default prefetch", async () => {
    authState.user = { id: "u1" }
    const { container } = render(<TopNav />)
    await waitFor(() => expect(prefetchOf(container, "Analytics")).toBe("default"))
  })
})
