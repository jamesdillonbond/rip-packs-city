// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

// Stub the achievement catalog so def lookups are deterministic.
vi.mock("@/lib/achievements", () => ({
  ACHIEVEMENT_DEFS: {
    first_wallet: { name: "First Wallet", description: "Loaded a wallet", emoji: "🏆" },
    whale: { name: "Whale", description: "Big bag", emoji: "🐳" },
  },
  getTierColor: () => "#abcdef",
  getHighestTierLabel: (_def: unknown, tier: string) => tier ?? "BRONZE",
}))

import PublicAchievements from "@/components/profile/PublicAchievements"

// PublicAchievements fetches unlocked achievements and renders a centered pill
// row with a "N unlocked" header. It renders nothing while unresolved or when
// empty, and silently skips achievement_keys with no catalog definition.

let fetchMock: ReturnType<typeof vi.fn>
function okJson(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("PublicAchievements", () => {
  it("renders nothing when the wallet has no achievements", async () => {
    fetchMock.mockReturnValue(okJson({ achievements: [] }))
    const { container } = render(<PublicAchievements ownerKey="0xabc" />)
    // Give the effect a tick; empty array → still renders null.
    await Promise.resolve()
    expect(container.firstChild).toBeNull()
  })

  it("does not fetch (and stays null) with an empty ownerKey", () => {
    const { container } = render(<PublicAchievements ownerKey="" />)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(container.firstChild).toBeNull()
  })

  it("renders the unlocked count, name, emoji and tier label; skips unknown keys", async () => {
    fetchMock.mockReturnValue(
      okJson({
        achievements: [
          { achievement_key: "first_wallet", tier: "GOLD" },
          { achievement_key: "does_not_exist", tier: "X" },
        ],
      })
    )
    const { container } = render(<PublicAchievements ownerKey="0xabc" />)
    await waitFor(() => expect(container.textContent).toContain("First Wallet"))
    const txt = container.textContent!
    // Header count is the raw items length (both rows counted).
    expect(txt).toContain("★ Achievements · 2 unlocked")
    expect(txt).toContain("🏆")
    expect(txt).toContain("GOLD")
    // Unknown key produced no pill body.
    expect(txt).not.toContain("does_not_exist")
  })
})
