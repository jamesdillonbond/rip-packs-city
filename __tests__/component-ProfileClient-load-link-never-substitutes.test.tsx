import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"

// A saved-wallet row's LOAD link opens THAT row's collection. Until 2026-10-10
// a row whose collection_id named no registry collection fell back to
// /nba-top-shot/collection — Top Shot under the row's own label. A row with NO
// collection_id is a legacy Top Shot save and keeps that link.

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

function row(username: string, collection_id: string | null) {
  return { id: username, username, collection_id, cached_fmv: 10, cached_moment_count: 1, cached_rpc_score: null } as never
}

describe("ProfileClient saved-wallet LOAD link", () => {
  const html = renderToString(
    <ProfileClient
      initialBio={null}
      initialWalletCount={3}
      initialWallets={[
        row("alldayguy", "dee28451-5d62-409e-a1ad-a83f763ac070"),
        row("ghostcoll", "00000000-0000-4000-8000-000000000000"),
        row("legacyts", null),
      ]}
    />,
  )

  it("links a known collection's row to that collection", () => {
    expect(html).toContain("/nfl-all-day/collection?wallet=alldayguy")
  })

  it("keeps the Top Shot link for a legacy row with no collection_id", () => {
    expect(html).toContain("/nba-top-shot/collection?wallet=legacyts")
  })

  it("gives an unknown collection's row NO link, never Top Shot's", () => {
    expect(html).toContain("ghostcoll") // the row itself still renders
    expect(html).not.toMatch(/collection\?wallet=ghostcoll/)
  })
})
