// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"
import { renderToString } from "react-dom/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// /profile/<username> — a portfolio we COULD NOT READ must not render as one that
// is empty. The FIFTH honesty layer, on the sub-class CLAUDE.md calls the worst:
// a false claim about the reader's OWN account.
//
// ── THE DEFECT (found 2026-09-02) ───────────────────────────────────────────
// The server page computed `result.ok` from `getPublicProfile` and then THREW IT
// AWAY, passing `initialWallets={[]}` on failure — byte-identical to a collector
// who holds nothing. The KPI tiles then render PORTFOLIO FMV "—" and MOMENTS "—",
// and the saved-wallet list does not render at all when the array is empty. So on
// their own profile, a collector who has added six wallets sees a page with no
// wallets and no indication anything failed — and re-adds work already done.
//
// It is the exact rendering this page's own header records as the 2026-06-12
// audit finding ("anon visitors, crawlers and link previews saw PORTFOLIO FMV —
// / 0 moments"), re-created for the failure path after the SSR seed fixed it for
// the loading path.
//
// ⚠ AND ISR MAKES ONE FAILURE STICK: the page sets `revalidate = 300`, so a
// single failed read is served to every visitor for five minutes.
//
// ⭐ A CORRECT SIBLING IS NOT A GUARD. `slabsError` — the same distinction, for
// the trophy case — was already in this component, twenty lines below the wallet
// fetch that lacked it, with a comment explaining exactly why it was needed.
//
// ── WHY renderToString ──────────────────────────────────────────────────────
// 🚨 ProfileClient DOES refetch on mount, so in jsdom the effect resolves and
// overwrites the seeded state before any assertion runs — the documented case
// where two OPPOSITE mutations (`useState(true)` / `useState(false)`) both leave
// every client test green. The seed's provenance survives only in server-rendered
// HTML, which is what crawlers, link unfurls and the pre-hydration paint get, and
// what ISR caches for the whole window.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({ useParams: () => ({ username: "trevor" }) }))
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))
vi.mock("@/components/RpcLogo", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/CostBasisCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/TopMoversCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/CollectionBreakdownCard", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/PublicAchievements", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/ShareProfileButtons", () => ({ default: () => <div /> }))
vi.mock("@/components/profile/FollowButton", () => ({ default: () => <div /> }))
vi.mock("@/components/TrophySlab", () => ({ default: () => <div /> }))

import ProfileClient from "@/app/profile/[username]/ProfileClient"

/** The phrase a reader would act on wrongly: it must never appear when we failed. */
const COULD_NOT_LOAD = /couldn.{0,3}t load this portfolio/i

describe("/profile: a failed seed is not an empty portfolio", () => {
  it("SSR: a FAILED seed says so, and says the figures are missing rather than zero", () => {
    const html = renderToString(
      <ProfileClient initialBio={null} initialWallets={[]} initialWalletCount={null} initialFailed />,
    )
    expect(html).toMatch(COULD_NOT_LOAD)
    // ⚠ Assert the ABSENCE of the false reading, not merely the presence of a
    // message — a banner above a board that still concludes is the documented
    // "fix per page, not per panel" failure. The claim being denied is that the
    // dashes mean zero.
    expect(html).toMatch(/MISSING, not zero/i)
  })

  it("NO-CHANGE CONTROL: a genuinely empty portfolio still says NOTHING about a failure", () => {
    // Without this, deleting the notice entirely would satisfy the case above,
    // and over-correcting is its own defect: every brand-new collector's profile
    // would look broken instead of new.
    const html = renderToString(
      <ProfileClient initialBio={null} initialWallets={[]} initialWalletCount={0} />,
    )
    expect(html).not.toMatch(COULD_NOT_LOAD)
  })

  it("NO-CHANGE CONTROL: a healthy seed with wallets still renders its real totals", () => {
    const html = renderToString(
      <ProfileClient
        initialBio={null}
        initialWalletCount={1}
        initialWallets={[
          {
            id: 1,
            label: "main",
            collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
            cached_fmv: 1234,
            cached_moment_count: 56,
            cached_rpc_score: null,
          } as never,
        ]}
      />,
    )
    expect(html).not.toMatch(COULD_NOT_LOAD)
    // The totals are real, so they are stated — the failure branch must not have
    // swallowed the healthy one.
    expect(html).toMatch(/56/)
  })

  it("the CLIENT fetch failing is named too — SSR honesty does not cover a later blip", async () => {
    // The SSR cases above cannot see this branch: they never run effects. A read
    // that SUCCEEDS on the server and fails on the client (rate limit, blip,
    // navigation) leaves the seeded wallets in place and renders them as fact.
    // The old code swallowed it twice over — `r.ok ? r.json() : null` discarded
    // the status, and `.catch(function() {})` discarded the throw.
    //
    // ⓘ Mutating the throw back to `r.ok ? r.json() : null` alone SURVIVES this
    // case, and that is correct rather than a gap: the next `.then` still throws
    // on the resulting null body, so the two forms are behaviourally equivalent
    // here. Recorded so nobody "fixes" the survivor by asserting the spelling of
    // a branch that does not change the outcome.
    const { render, screen, cleanup } = await import("@testing-library/react")
    const { waitFor } = await import("@testing-library/react")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/api/public/profile/")
          ? ({ ok: false, status: 503, json: async () => ({}) } as never)
          : ({ ok: true, status: 200, json: async () => ({}) } as never),
      ),
    )
    try {
      render(<ProfileClient initialBio={null} initialWallets={[]} initialWalletCount={null} />)
      await waitFor(() => expect(screen.getByText(COULD_NOT_LOAD)).toBeTruthy())
    } finally {
      cleanup()
      vi.unstubAllGlobals()
    }
  })

  it("a client fetch that SUCCEEDS clears a server-seeded failure — the notice must not outlive it", async () => {
    // Found by mutation: removing `setProfileError(false)` from the success path
    // left every other case green. The SSR read and the client read are different
    // reads, and the client routinely succeeds where a cold server render timed
    // out — so a stale seed must not leave a permanent "couldn't load" on a
    // profile that is loading perfectly. Over-correcting is its own defect.
    const { render, screen, cleanup, waitFor } = await import("@testing-library/react")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/api/public/profile/")
          ? ({
              ok: true,
              status: 200,
              json: async () => ({ bio: null, wallets: [], wallet_count: 0 }),
            } as never)
          : ({ ok: true, status: 200, json: async () => ({}) } as never),
      ),
    )
    try {
      render(<ProfileClient initialBio={null} initialWallets={[]} initialWalletCount={null} initialFailed />)
      await waitFor(() => expect(screen.queryByText(COULD_NOT_LOAD)).toBeNull())
    } finally {
      cleanup()
      vi.unstubAllGlobals()
    }
  })

  it("the server page passes the provenance it computes, instead of discarding it", () => {
    // The seed is built in page.tsx; a component that handles `initialFailed`
    // perfectly is inert if nothing ever sets it. `result.ok` existed in that
    // file all along and was dropped on the floor.
    const src = readFileSync(join(process.cwd(), "app/profile/[username]/page.tsx"), "utf8")
    expect(src).toMatch(/initialFailed=\{!result\.ok\}/)
  })
})
