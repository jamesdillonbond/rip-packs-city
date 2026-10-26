// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

/**
 * Panini edition-page parity sections (2026-10-25): Offers, Holders, Packs From This Product.
 * Stated as the ABSENCE of the false claims: a failed read is never "no offers" / "0 collectors"
 * / "no packs"; Holders never names a collector and never states a concentration share without a
 * complete census of enough copies; the product's packs are never said to contain this card.
 */

vi.mock("next/link", () => ({ default: ({ children, href }: any) => <a href={href}>{children}</a> }))

import { PaniniOffersSection, PaniniHoldersSection, PaniniProductPacksSection } from "@/components/entity/PaniniEditionExtras"
import type { PaniniEditionHolders } from "@/lib/panini/edition-extras"

afterEach(cleanup)

const H: PaniniEditionHolders = {
  serialsSeen: 199, ownedCopies: 120, unopenedCopies: 79, burntCopies: 0, holders: 61,
  top1Copies: 14, top3Copies: 30, top1Share: 0.1167, top3Share: 0.25, censusComplete: true, computedAt: "2026-10-25T12:29:00Z",
}

describe("PaniniOffersSection", () => {
  it("a failed read says couldn't load — never 'no offer'", () => {
    const c = render(<PaniniOffersSection offers={{ rows: null, serialsWithOffer: null }} />).container
    expect(c.querySelector('[data-testid="panini-offers-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/No offer/)
  })
  it("an ok empty read names the confirmation window", () => {
    const c = render(<PaniniOffersSection offers={{ rows: [], serialsWithOffer: 0 }} />).container
    expect(c.querySelector('[data-testid="panini-offers-empty"]')?.textContent).toContain("7 days")
  })
  it("rows show offer, count, ask or 'not listed', and a sealed serial as still in a pack", () => {
    const c = render(
      <PaniniOffersSection
        offers={{
          serialsWithOffer: 42,
          rows: [
            { serial: 7, mintCap: 199, bestOfferUsd: 25, offersCount: 3, askUsd: 40, sealed: false, seenAt: "2026-10-25T00:00:00Z" },
            { serial: 12, mintCap: 199, bestOfferUsd: 5, offersCount: 1, askUsd: null, sealed: true, seenAt: null },
          ],
        }}
      />,
    ).container
    const t = c.querySelector('[data-testid="panini-offers"]')!.textContent!
    expect(t).toContain("#7/199")
    expect(t).toContain("$25")
    expect(t).toContain("not listed")
    expect(t).toContain("still in a pack")
    expect(c.textContent).toContain("42 serials carry one")
  })
})

describe("PaniniOffersSection — sparse rows", () => {
  it("a missing serial, cap, count or time renders a dash, and one serial is singular", () => {
    const c = render(
      <PaniniOffersSection offers={{ serialsWithOffer: 1, rows: [{ serial: null, mintCap: null, bestOfferUsd: 3, offersCount: null, askUsd: null, sealed: false, seenAt: null }] }} />,
    ).container
    expect(c.textContent).toContain("1 serial carry one")
    expect(c.querySelector('[data-testid="panini-offers"]')?.textContent).toContain("—")
  })
  it("a serial with no cap shows #N", () => {
    const c = render(
      <PaniniOffersSection offers={{ serialsWithOffer: null, rows: [{ serial: 4, mintCap: null, bestOfferUsd: 3, offersCount: 2, askUsd: null, sealed: false, seenAt: null }] }} />,
    ).container
    expect(c.textContent).toContain("#4")
    expect(c.textContent).not.toContain("carry one")
  })
})

describe("PaniniHoldersSection — edges", () => {
  it("shows burned copies when there are any, and a missing timestamp is fine", () => {
    const c = render(<PaniniHoldersSection ok holders={{ ...H, burntCopies: 2, computedAt: null, serialsSeen: 1 }} />).container
    expect(c.textContent).toContain("Burned")
    expect(c.textContent).toContain("1 serial RPC has seen")
  })
})

describe("PaniniHoldersSection", () => {
  it("a failed read never renders a count", () => {
    const c = render(<PaniniHoldersSection ok={false} holders={null} />).container
    expect(c.querySelector('[data-testid="panini-holders-failed"]')).not.toBeNull()
    expect(c.querySelector('[data-testid="panini-holders-count"]')).toBeNull()
  })
  it("no row yet is not '0 collectors'", () => {
    const c = render(<PaniniHoldersSection ok holders={null} />).container
    expect(c.textContent).toContain("hasn't counted")
    expect(c.textContent).not.toMatch(/\b0 collectors?\b/i)
  })
  it("complete census over enough copies shows shares; counts only, no handle", () => {
    const c = render(<PaniniHoldersSection ok holders={H} />).container
    expect(c.querySelector('[data-testid="panini-holders-count"]')?.textContent).toContain("61")
    expect(c.querySelector('[data-testid="panini-holders-top1"]')?.textContent).toContain("11.7%")
    expect(c.textContent).toContain("never named")
    expect(c.querySelector("a")).toBeNull()
  })
  it("an incomplete census withholds concentration and says why", () => {
    const c = render(<PaniniHoldersSection ok holders={{ ...H, censusComplete: false }} />).container
    expect(c.querySelector('[data-testid="panini-holders-top1"]')).toBeNull()
    expect(c.querySelector('[data-testid="panini-holders-no-share"]')?.textContent).toContain("hasn't seen every serial")
  })
  it("a census of a handful of copies withholds concentration (no '100%' on a /1)", () => {
    const c = render(<PaniniHoldersSection ok holders={{ ...H, ownedCopies: 1, top1Copies: 1, top1Share: 1, top3Share: 1 }} />).container
    expect(c.textContent).not.toContain("100.0%")
  })
})

describe("PaniniProductPacksSection", () => {
  const pack = { id: "1038", title: "Hobby pack", productName: "2026 Prizm World Cup", costUsd: 135, costBasis: "floor" as const, packsRemaining: 900, packsTotal: 5000, updatedAt: null, marketUrl: "https://nft.paniniamerica.net/x" }
  it("a failed read is never 'no packs'", () => {
    const c = render(<PaniniProductPacksSection collection="panini-blockchain" packs={{ packs: null, productName: null, stillInPacks: null, fotlExclusive: false, productSetId: null }} />).container
    expect(c.querySelector('[data-testid="panini-packs-failed"]')).not.toBeNull()
    expect(c.textContent).not.toMatch(/tracks no pack/)
  })
  it("never claims a listed pack can pull this card", () => {
    const c = render(<PaniniProductPacksSection collection="panini-blockchain" packs={{ packs: [pack], productName: "2026 Prizm World Cup", stillInPacks: 79, fotlExclusive: false, productSetId: null }} />).container
    expect(c.textContent).toContain("can't say which of them can pull this card")
    expect(c.textContent).toContain("79 copies of this edition are still sealed")
    expect(c.textContent).toContain("900 of 5,000 left")
    expect(c.querySelector('a[href="/panini-blockchain/packs"]')).not.toBeNull()
  })
  it("a FOTL exclusive says only FOTL packs carry it", () => {
    const c = render(<PaniniProductPacksSection collection="panini-blockchain" packs={{ packs: [{ ...pack, title: "FOTL pack" }], productName: null, stillInPacks: 2, fotlExclusive: true, productSetId: 2332 }} />).container
    expect(c.textContent).toContain("only FOTL packs carry it")
  })
})
