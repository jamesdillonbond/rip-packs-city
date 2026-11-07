// 2026-11-06 — the dashboard's Settings tab is the HOME of the three
// settings-class pages (IA rule 1: a feature ships with a home). Each of them
// must link back to the tab it is reached from, not to the Overview, and the
// tab must reach every one of them — /dashboard/api-keys had NO entry point
// but the concierge before this pin.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

const read = (p: string) => readFileSync(p, "utf8")

const SETTINGS_PAGES = [
  "app/dashboard/notifications/NotificationsClient.tsx",
  "app/profile/edit/ProfileEditClient.tsx",
  "app/dashboard/api-keys/ApiKeysClient.tsx",
]

describe("settings-class pages and the Settings tab agree", () => {
  it("each settings page returns to /dashboard?tab=settings, never to the bare dashboard", () => {
    for (const p of SETTINGS_PAGES) {
      const src = read(p)
      expect(src, p).toContain('href="/dashboard?tab=settings"')
      expect(src, p).not.toMatch(/href="\/dashboard"[\s\S]{0,200}←/)
      expect(src, p).not.toMatch(/← (Back to )?[Dd]ashboard/)
    }
  })

  it("the Settings tab links to every settings-class page", () => {
    const dash = read("app/dashboard/DashboardClient.tsx")
    for (const href of ["/dashboard/notifications", "/profile/edit", "/dashboard/api-keys", "/alerts"]) {
      expect(dash).toContain(`href="${href}"`)
    }
  })
})

describe("the API keys page shows no plan tier", () => {
  // 2026-11-06 walk: the key card printed the raw internal plan enum
  // ("Plan FOUNDING") — a paid tier shown before 100 WAU, and an enum leak.
  it("ApiKeysClient never renders `plan` and the page carries its own title", () => {
    const src = read("app/dashboard/api-keys/ApiKeysClient.tsx")
    const code = stripComments(src)
    expect(code).not.toMatch(/\{k\.plan\}/)
    expect(code).not.toMatch(/>\s*Plan(&nbsp;|\s)/)
    expect(read("app/dashboard/api-keys/page.tsx")).toMatch(/title:\s*"API keys"/)
  })
})
