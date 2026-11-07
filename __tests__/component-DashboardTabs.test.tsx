// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import DashboardTabs from "@/components/dashboard/DashboardTabs"
import { DASH_TABS, panelHref, parseDashTab } from "@/lib/dashboard-tabs"

// IA Phase 1 (2026-11-06): one tab row on all five dashboard surfaces. On
// /dashboard the panel tabs switch in place; on the two page-tabs they are
// links back, and the page's own tab is current.

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children?: React.ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, string>)}>{children}</a>
  ),
}))

afterEach(() => cleanup())

describe("DashboardTabs", () => {
  it("lists the five tabs in order", () => {
    expect(DASH_TABS.map((t) => t.label)).toEqual(["Overview", "Trophy Cases", "Packs", "History", "Settings"])
  })

  it("on /dashboard: panel tabs are buttons that call onSelect; page tabs are links", () => {
    const onSelect = vi.fn()
    const { container } = render(<DashboardTabs active="overview" onSelect={onSelect} />)
    expect(container.querySelector('[role="tablist"]')).toBeTruthy()
    const buttons = Array.from(container.querySelectorAll('button[role="tab"]')).map((b) => b.textContent)
    expect(buttons).toEqual(["Overview", "Trophy Cases", "Settings"])
    expect(container.querySelector('button[aria-selected="true"]')!.textContent).toBe("Overview")
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Settings")!)
    expect(onSelect).toHaveBeenCalledWith("settings")
    const links = Array.from(container.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")])
    expect(links).toEqual([["Packs", "/dashboard/packs"], ["History", "/dashboard/history"]])
  })

  it("on a page tab (Packs): every tab is a link, the page's own tab is aria-current, panels deep-link back", () => {
    const { container } = render(<DashboardTabs active="packs" />)
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(container.querySelector('[role="navigation"][aria-label="Dashboard sections"]')).toBeTruthy()
    const links = Array.from(container.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("aria-current")])
    expect(links).toEqual([
      ["Overview", "/dashboard", null],
      ["Trophy Cases", "/dashboard?tab=trophy", null],
      ["Packs", "/dashboard/packs", "page"],
      ["History", "/dashboard/history", null],
      ["Settings", "/dashboard?tab=settings", null],
    ])
    expect(container.querySelectorAll("button").length).toBe(0)
  })

  it("panelHref and parseDashTab round-trip; unknown → overview", () => {
    expect(panelHref("overview")).toBe("/dashboard")
    expect(parseDashTab(new URL("https://x" + panelHref("trophy")).searchParams.get("tab"))).toBe("trophy")
    expect(parseDashTab("nope")).toBe("overview")
    expect(parseDashTab(null)).toBe("overview")
  })

  it("every tab is a ≥44px target (minHeight) so the row is tappable on a phone", () => {
    const { container } = render(<DashboardTabs active="history" />)
    for (const a of Array.from(container.querySelectorAll("a")) as HTMLElement[]) {
      expect(parseInt(a.style.minHeight, 10)).toBeGreaterThanOrEqual(44)
    }
  })
})
