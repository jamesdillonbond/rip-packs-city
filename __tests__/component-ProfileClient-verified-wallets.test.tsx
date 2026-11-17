// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"

// 2026-11-15: the public profile says how many of the collector's wallets are
// VERIFIED (listing challenge / attestation) — a trust signal for trades, and a
// reason to press Verify. Absent or zero renders nothing; it never claims more.

vi.mock("next/navigation", () => ({ useParams: () => ({ username: "trevor" }) }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/TopMoversCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/CollectionBreakdownCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/PublicAchievements", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/ShareProfileButtons", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/FollowButton", () => ({ default: () => <div /> }))
vi.mock("@/components/TrophySlab", () => ({ default: () => <div /> }))

import ProfileClient from "@/app/profile/[username]/ProfileClient"

const W = { username: null, display_name: null, collection_id: "c", cached_fmv: 10, cached_moment_count: 3 } as any

describe("/profile: verified wallets", () => {
  it("says VERIFIED when every wallet is verified", () => {
    const html = renderToString(<ProfileClient initialWallets={[W]} initialWalletCount={1} initialVerifiedWalletCount={1} />)
    expect(html).toMatch(/✓ (<!-- -->)?VERIFIED/)
  })
  it("gives the number when only some are", () => {
    const html = renderToString(<ProfileClient initialWallets={[W]} initialWalletCount={2} initialVerifiedWalletCount={1} />)
    expect(html).toMatch(/1 VERIFIED/)
  })
  it("says nothing when none are verified, or the count is absent", () => {
    for (const v of [0, null]) {
      const html = renderToString(<ProfileClient initialWallets={[W]} initialWalletCount={1} initialVerifiedWalletCount={v} />)
      expect(html).not.toMatch(/VERIFIED/)
    }
  })
})
