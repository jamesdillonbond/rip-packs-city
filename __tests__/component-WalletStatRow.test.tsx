// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// next/link is not needed for logic here — stub it to a plain anchor so the
// component (via FmvDisclaimer) renders in jsdom without the Next runtime.
vi.mock("next/link", () => ({
  default: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

// 2026-11-16: UFC Strike, the only closed market, now takes the UFC-on-Aptos binder path (Flow
// holdings valued, with a migrate note). So the generic closed-market branch keeps a subject that
// genuinely lacks that path: a synthetic closed slug, declared here.
vi.mock("@/lib/market-closed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/market-closed")>()
  const fake = { closedOn: "2026-01-02", venue: "Testchain", note: "Test market closed." }
  return {
    ...actual,
    closedMarket: (slug: string) => (slug === "test-closed" ? fake : actual.closedMarket(slug)),
    isMarketClosed: (slug: string) => slug === "test-closed" || actual.isMarketClosed(slug),
  }
})

import WalletStatRow, { WalletStatRowProps } from "@/components/wallet-stat-row"

afterEach(cleanup)

function props(overrides: Partial<WalletStatRowProps> = {}): WalletStatRowProps {
  return {
    walletFmv: 1000,
    unlockedFmv: 600,
    lockedFmv: 400,
    bestOfferTotal: 800,
    momentCount: 12,
    unlockedCount: 8,
    lockedCount: 4,
    spreadGap: 200,
    collectionSlug: "nba-top-shot",
    ...overrides,
  }
}

describe("WalletStatRow", () => {
  // 2026-11-24 (Trevor, "very simple and digestible, no subtext"): one big Collection value, then
  // plain stats — Moments · Unlocked · Top offers (· Profit / Loss). No captions.
  it("renders one headline value and the plain stats", () => {
    const { container, getByTestId } = render(<WalletStatRow {...props()} />)
    expect(getByTestId("binder-hero-value").textContent).toBe("$1,000")
    expect(getByTestId("binder-stat-count").textContent).toBe("Moments12")
    expect(getByTestId("binder-stat-unlocked").textContent).toBe("Unlocked$600")
    expect(getByTestId("binder-stat-offers").textContent).toBe("Top offers$800")
    const txt = container.textContent!
    expect(txt).not.toContain("Locked FMV")
    expect(txt).not.toContain("vs their FMV")
  })

  it("uses 'Pins' as the count label for Disney Pinnacle and shows no Unlocked stat", () => {
    const { container, getByTestId } = render(<WalletStatRow {...props({ collectionSlug: "disney-pinnacle" })} />)
    expect(getByTestId("binder-stat-count").textContent).toBe("Pins12")
    expect(container.textContent).not.toMatch(/locked/i)
  })

  it("renders Profit / Loss only when given the wallet's P&L, signed and coloured", () => {
    const none = render(<WalletStatRow {...props()} />)
    expect(none.container.textContent).not.toContain("Profit / Loss")
    none.unmount()
    const down = render(<WalletStatRow {...props({ pnl: { amount: -81941.27, pct: -68.39 } })} />)
    const el = down.getByTestId("binder-stat-pnl")
    expect(el.textContent).toBe("Profit / Loss-$81,941 (-68%)")
    expect(el.innerHTML).toContain("rpc-binder-hero-stat-value--down")
    down.unmount()
    const up = render(<WalletStatRow {...props({ pnl: { amount: 1000, pct: 25 } })} />)
    expect(up.getByTestId("binder-stat-pnl").textContent).toBe("Profit / Loss+$1,000 (+25%)")
  })

  it("draws the where-it-came-from bar and skips empty sources", () => {
    const { getByTestId } = render(<WalletStatRow {...props({ acquisition: { packs: 6746, market: 8712, rewards: 0, total: 15458 } })} />)
    const txt = getByTestId("binder-source").textContent!
    expect(txt).toContain("Packs 6,746")
    expect(txt).toContain("Market 8,712")
    expect(txt).not.toContain("Rewards")
  })

  it("keeps the unchecked-lock FMV out of Unlocked and names it on hover only", () => {
    const { getByTestId } = render(<WalletStatRow {...props({ unlockedFmv: 600, lockUnknownFmv: 50, lockUnknownCount: 3 })} />)
    const el = getByTestId("binder-stat-unlocked")
    expect(el.textContent).toBe("Unlocked$600")
    expect(el.getAttribute("title")).toBe("3 moments not checked yet ($50.00) — not counted here")
  })

  // 2026-11-09 INVERTED: this pinned "n/a for this collection" for a null locked count. The Locked
  // tile only renders on a collection that HAS locking, so that phrase was false wherever it showed
  // (Top Shot, for the first seconds of every load). A null count is unknown, not inapplicable.
  it("shows an em-dash for a null FMV and a null locked count, never 'n/a for this collection'", () => {
    const { container } = render(
      <WalletStatRow {...props({ lockedFmv: null, lockedCount: null })} />
    )
    expect(container.textContent).toContain("—")
    expect(container.textContent).not.toContain("n/a for this collection")
    expect(container.textContent).not.toContain("null locked")
  })

  it("⛔ every moment unchecked → Unlocked is unknown (—), never a fabricated $0 (2026-11-26)", () => {
    const { getByTestId } = render(<WalletStatRow {...props({ unlockedFmv: 0, unlockedCount: 0, lockedFmv: 0, lockedCount: 0, lockUnknownFmv: 57.16, lockUnknownCount: 295 })} />)
    const el = getByTestId("binder-stat-unlocked")
    expect(el.textContent).toBe("Unlocked—")
    expect(el.textContent).not.toContain("$0")
    expect(el.getAttribute("title")).toBe("295 moments not checked yet ($57.16) — not counted here")
  })

  it("a wallet whose every checked moment is locked still reads a real $0 Unlocked", () => {
    const { getByTestId } = render(<WalletStatRow {...props({ unlockedFmv: 0, unlockedCount: 0, lockUnknownFmv: 0, lockUnknownCount: 0 })} />)
    expect(getByTestId("binder-stat-unlocked").textContent).toBe("Unlocked$0")
  })

  it("distinguishes a real computed $0 from missing data", () => {
    const { container } = render(<WalletStatRow {...props({ unlockedFmv: 0 })} />)
    expect(container.textContent).toContain("$0")
  })

  it("shows a count + closure note (no dollar total) for a closed market", () => {
    // A closed market must show a count + note, never a portfolio total (which
    // would assert a value that no longer exists). Re-pinned 2026-11-16 onto a
    // synthetic closed slug: UFC now takes the Aptos-binder path below.
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "test-closed" })} />)
    const txt = container.textContent!
    expect(txt).toContain("12 moments")
    expect(txt).toContain("Market closed")
    expect(txt).not.toContain("$1,000")
    expect(txt).not.toContain("$800")
  })

  // RE-PINNED 2026-11-26 (Trevor: "view this from a chain-agnostic view and … aggregate across the multiple
  // chains/wallets"): ONE UFC value over Flow + Aptos, the split named in the caption, and no migration
  // messaging. The 11-16 property that survives: the Flow half is headline + stale (capped snapshots sit in
  // the stale share), never the netted near-$0 headline.
  it("UFC: one value across Flow (headline + stale) and Aptos, with the split in the caption", () => {
    const { container } = render(
      <WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 1234.5, staleCount: 12, ufcAptos: { status: "ok", count: 3, totalFmv: 100, unpriced: 0, capped: false } })} />,
    )
    const txt = container.textContent!
    expect(txt).toContain("Your Holdings · current FMV")
    expect(txt).toContain("$1,334")
    expect(txt).toContain("12 on Flow")
    expect(txt).toContain("3 on Aptos")
    expect(txt).not.toMatch(/migrate/i)
    expect(txt).not.toContain("Market closed")
  })

  it("UFC: everything on Aptos values the Aptos half alone — no Flow zero, no em dash", () => {
    const { container } = render(
      <WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 0, momentCount: 0, ufcAptos: { status: "ok", count: 1855, totalFmv: 6936.71, unpriced: 0, capped: false } })} />,
    )
    const txt = container.textContent!
    expect(txt).toContain("$6,936.71")
    expect(txt).toContain("1,855 on Aptos")
    expect(txt).not.toContain("on Flow")
  })

  it("UFC: a failed Aptos read is disclosed as not included, never a silent Flow-only total", () => {
    const { container } = render(
      <WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 50, momentCount: 2, ufcAptos: { status: "failed" } })} />,
    )
    const txt = container.textContent!
    expect(txt).toContain("$50")
    expect(txt).toContain("Aptos holdings couldn't load — not included")
  })

  it("UFC: while Aptos loads the caption says so", () => {
    const { container } = render(
      <WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 50, momentCount: 2, ufcAptos: { status: "loading" } })} />,
    )
    expect(container.textContent).toContain("Adding Aptos holdings…")
  })

  it("UFC: an Aptos account searched directly that holds none says so about that account", () => {
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: null, momentCount: 0, ufcAptos: { status: "none", direct: true } })} />)
    expect(container.textContent).toContain("No UFC Strike moments found in this Aptos account")
    expect(container.textContent).not.toContain("on Flow")
  })

  it("UFC: nothing on either chain is a found-nothing line, not $0", () => {
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 0, momentCount: 0, ufcAptos: { status: "none" } })} />)
    const txt = container.textContent!
    expect(txt).toContain("No UFC Strike moments found on Flow or on an Aptos account linked to this wallet")
    expect(txt).not.toMatch(/\$0(?![.,\d])/)
  })

  it("UFC: Aptos Moments with no current FMV and nothing on Flow is an em dash, never $0", () => {
    const { container } = render(
      <WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: 0, staleFmv: 0, momentCount: 0, ufcAptos: { status: "ok", count: 4, totalFmv: null, unpriced: 4, capped: false } })} />,
    )
    const txt = container.textContent!
    expect(txt).toContain("—")
    expect(txt).not.toMatch(/\$0(?![.,\d])/)
    expect(txt).toContain("4 on Aptos without a current FMV")
  })

  it("UFC: an unloaded summary is an em dash, never $0", () => {
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "ufc", walletFmv: null })} />)
    expect(container.textContent).toContain("—")
    expect(container.textContent).not.toMatch(/\$0(?![.,\d])/)
  })

  it("still shows the dollar headline for a live market", () => {
    const { container } = render(<WalletStatRow {...props({ collectionSlug: "nba-top-shot" })} />)
    expect(container.textContent).toContain("$1,000")
    expect(container.textContent).not.toContain("Market closed")
  })

  it("swaps the caption for a hydration progress bar when loadProgress is partial", () => {
    const { container } = render(
      <WalletStatRow {...props({ loadProgress: { loaded: 30, total: 120, pct: 25 } })} />
    )
    const txt = container.textContent!
    expect(txt).toContain("Loading 30 / 120 moments")
    expect(txt).toContain("25%")
  })

  // 2026-11-24: the 11-22 one-number rule reaches the binder — the stale-priced share is IN the
  // headline, not a caption under it (was: total − stale, split disclosed beside it).
  it("folds the stale-priced share into the one headline, with no caption", () => {
    const { container, getByTestId } = render(<WalletStatRow {...props({ walletFmv: 41039.07, staleFmv: 5224.5, staleCount: 8 })} />)
    expect(getByTestId("binder-hero-value").textContent).toBe("$46,264")
    expect(container.textContent).not.toContain("stale")
  })
  it("a raw total whose split never arrived is still just the number", () => {
    const { container, getByTestId } = render(<WalletStatRow {...props({ walletFmv: 87786.31, staleUnknown: true })} />)
    expect(getByTestId("binder-hero-value").textContent).toBe("$87,786")
    expect(container.textContent).not.toMatch(/across \d+ stale-priced/)
  })
  it("a known ZERO split is silent — no caption, no 'unavailable'", () => {
    const { container } = render(<WalletStatRow {...props({ walletFmv: 500, staleFmv: 0, staleCount: 0, staleUnknown: false })} />)
    const txt = container.textContent ?? ""
    expect(txt).not.toContain("stale")
  })
})

describe("formatUsdWhole", () => {
  it("keeps the three states and rounds to whole dollars", async () => {
    const { formatUsdWhole } = await import("@/components/wallet-stat-row")
    expect(formatUsdWhole(null)).toBe("—")
    expect(formatUsdWhole(0)).toBe("$0")
    expect(formatUsdWhole(0.4)).toBe("$0.40") // a real non-zero never rounds to "$0"
    expect(formatUsdWhole(41039.07)).toBe("$41,039")
    expect(formatUsdWhole(-81941.27)).toBe("-$81,941")
  })
})

// 2026-11-24: live Pinnacle drew one full-width "Packs 31" bar for a 187-pin wallet — the bar must
// span the whole count, with the unknown-source remainder as its own share, never stretched packs.
describe("WalletStatRow source bar covers the whole count", () => {
  it("adds an Other share for moments whose source is unknown, and shows gifts", async () => {
    const { render } = await import("@testing-library/react")
    const WalletStatRow = (await import("@/components/wallet-stat-row")).default
    const r = render(<WalletStatRow {...props({ walletFmv: 1010, momentCount: 187, collectionSlug: "disney-pinnacle",
      acquisition: { packs: 31, market: 0, rewards: 0, gifts: 2, total: 33 } })} />)
    const txt = r.getByTestId("binder-source").textContent!
    expect(txt).toContain("Packs 31")
    expect(txt).toContain("Gifts 2")
    expect(txt).toContain("Other 154")
    r.unmount()
  })
  it("draws no Other share when every moment's source is known", async () => {
    const { render } = await import("@testing-library/react")
    const WalletStatRow = (await import("@/components/wallet-stat-row")).default
    const r = render(<WalletStatRow {...props({ momentCount: 12, collectionSlug: "nba-top-shot",
      acquisition: { packs: 7, market: 5, rewards: 0, total: 12 } })} />)
    expect(r.getByTestId("binder-source").textContent).not.toContain("Other")
    r.unmount()
  })
})
