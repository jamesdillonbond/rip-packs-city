// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// MomentDetailModal — live on the sniper + collection pages (the audit docs
// wrongly flagged it as dead code). Pins the Moment-V3 a11y contract (dialog
// role, Escape-to-close, backdrop-vs-content click semantics) and the
// Flowty-shutdown CTA rule (a flowty-sourced buyUrl must NOT render a Buy CTA).

import MomentDetailModal from "@/components/MomentDetailModal"

afterEach(cleanup)

function moment(over: Record<string, unknown> = {}) {
  return {
    flowId: "12345",
    playerName: "Damian Lillard",
    setName: "Base Set",
    tier: "RARE",
    serialNumber: 7,
    mintSize: 749,
    fmv: 42.5,
    listingPrice: 30,
    buyUrl: "https://nbatopshot.com/listings/p2p/x",
    ...over,
  }
}

describe("MomentDetailModal — a11y contract (Moment V3)", () => {
  it("renders as an aria-modal dialog and closes on Escape", () => {
    const onClose = vi.fn()
    const { getByRole } = render(<MomentDetailModal moment={moment()} onClose={onClose} />)
    const dialog = getByRole("dialog")
    expect(dialog.getAttribute("aria-modal")).toBe("true")

    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("closes on backdrop click but NOT on clicks inside the dialog content", () => {
    const onClose = vi.fn()
    const { getByRole, getByText } = render(
      <MomentDetailModal moment={moment()} onClose={onClose} />,
    )
    fireEvent.click(getByText("Damian Lillard"))
    expect(onClose).not.toHaveBeenCalled()

    const backdrop = getByRole("dialog").parentElement!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("the close button is labeled for screen readers and fires onClose", () => {
    const onClose = vi.fn()
    const { getByLabelText } = render(<MomentDetailModal moment={moment()} onClose={onClose} />)
    fireEvent.click(getByLabelText("Close Damian Lillard details"))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders nothing when moment is null", () => {
    const { container } = render(<MomentDetailModal moment={null} onClose={() => {}} />)
    expect(container.innerHTML).toBe("")
  })
})

describe("MomentDetailModal — ASK_ONLY 'from asks' honesty marker", () => {
  it("shows the 'from asks' marker for an ask-derived FMV", () => {
    const { getByText } = render(
      <MomentDetailModal moment={moment({ marketConfidence: "ask_only" })} onClose={() => {}} />,
    )
    expect(getByText("from asks")).toBeTruthy()
  })

  it("does NOT show the marker for a sale-derived FMV (and never the confidence enum)", () => {
    const { queryByText } = render(
      <MomentDetailModal moment={moment({ marketConfidence: "high" })} onClose={() => {}} />,
    )
    expect(queryByText("from asks")).toBeNull()
    // The internal confidence vocabulary must never reach the DOM.
    expect(queryByText(/high/i)).toBeNull()
  })
})

describe("MomentDetailModal — marketplace CTA rules", () => {
  it("shows the buy link for a topshot-sourced listing", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} marketplaceSource="topshot" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("https://nbatopshot.com/listings/p2p/x")
  })

  it("hides the buy CTA for a flowty-sourced listing (marketplace shut down May 2026)", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} marketplaceSource="flowty" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).not.toContain("https://nbatopshot.com/listings/p2p/x")
  })

  it("renders the dapper.market secondary link when dapperUrl is provided", () => {
    const { container } = render(
      <MomentDetailModal moment={moment()} dapperUrl="https://dapper.market/x" onClose={() => {}} />,
    )
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("https://dapper.market/x")
  })
})

describe("MomentDetailModal — financial cells + provenance branches", () => {
  it("renders serial/mint, listing, best offer, and badges", () => {
    const { container } = render(
      <MomentDetailModal
        moment={moment({
          bestOffer: 300,
          badgeTitles: ["Rookie Year"],
          officialBadges: ["Championship"],
        })}
        onClose={() => {}}
      />,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("#7") // serialNumber
    expect(text).toContain("749") // mintSize
    expect(text).toContain("$300.00") // bestOffer > 0
    expect(text).toContain("Rookie Year")
    expect(text).toContain("Championship")
  })

  it("omits the best-offer cell when the offer is zero (never shows $0.00)", () => {
    const { container } = render(
      <MomentDetailModal moment={moment({ bestOffer: 0 })} onClose={() => {}} />,
    )
    expect((container.textContent ?? "")).not.toContain("$0.00")
  })

  it("omits serial/mint/fmv/listing cells when those fields are null", () => {
    const { getByText, container } = render(
      <MomentDetailModal
        moment={moment({ serialNumber: null, mintSize: null, fmv: null, listingPrice: null })}
        onClose={() => {}}
      />,
    )
    expect(getByText("Damian Lillard")).toBeTruthy() // shell still renders
    expect((container.textContent ?? "")).not.toContain("#7")
  })

  it("renders each deal-rating colour band (>=0.7 / >=0.4 / <0.4 / null) without error", () => {
    for (const dealRating of [0.9, 0.55, 0.2, null]) {
      const { getByRole, unmount } = render(
        <MomentDetailModal moment={moment({ dealRating })} onClose={() => {}} />,
      )
      expect(getByRole("dialog")).toBeTruthy()
      unmount()
    }
  })

  it("renders the loan-default provenance block: truncated source wallet + principal", () => {
    const { container } = render(
      <MomentDetailModal
        moment={moment({
          acquisitionMethod: "loan_default",
          sourceAddress: "0xbd94cade097e50ac",
          loanPrincipal: 1200,
        })}
        onClose={() => {}}
      />,
    )
    const text = container.textContent ?? ""
    expect(text).toContain("0xbd94…50ac") // truncateAddress
    expect(text).toContain("$1200.00") // loanPrincipal (USDC 1:1 USD)
    // the wallet links to its analytics page
    const links = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(links).toContain("/analytics/wallets/0xbd94cade097e50ac")
  })
})

// Quirky-serial chips (2026-08-13). Passive discovery: a collector notices a
// palindrome while looking at the moment, without having to ask the concierge.
describe("MomentDetailModal — quirky-serial chips", () => {
  it("shows a chip for a palindrome serial, with its reason as the tooltip", () => {
    const { getByLabelText, getByText } = render(
      <MomentDetailModal moment={moment({ serialNumber: 1221, mintSize: 3000 })} onClose={() => {}} />
    )
    expect(getByLabelText("Serial number quirks")).toBeTruthy()
    const chip = getByText("Palindrome")
    // The reason must ride along — "Palindrome" alone is unverifiable at a glance.
    expect(chip.getAttribute("title")).toContain("reads the same backwards")
  })

  it("shows nothing at all for an ordinary serial", () => {
    const { queryByLabelText } = render(
      <MomentDetailModal moment={moment({ serialNumber: 4817, mintSize: 3000 })} onClose={() => {}} />
    )
    // An ordinary serial is the normal case; an empty chip row would be noise.
    expect(queryByLabelText("Serial number quirks")).toBeNull()
  })

  it("flags the last mint only when the mint size is known", () => {
    const { getByText } = render(
      <MomentDetailModal moment={moment({ serialNumber: 749, mintSize: 749 })} onClose={() => {}} />
    )
    expect(getByText("Last mint")).toBeTruthy()

    cleanup()
    const { queryByText } = render(
      <MomentDetailModal moment={moment({ serialNumber: 749, mintSize: null })} onClose={() => {}} />
    )
    expect(queryByText("Last mint")).toBeNull()
  })

  // ⚠ These carry NO value premium, and the styling has to say so. FMV renders
  // in green (#22c55e) a few lines below in this same modal, and green reads as
  // MONEY here — a chip in the FMV colour would imply a premium the data does
  // not support. Neutral tokens only.
  it("does not style the chips like a price", () => {
    const { getByText } = render(
      <MomentDetailModal moment={moment({ serialNumber: 420, mintSize: 3000 })} onClose={() => {}} />
    )
    const chip = getByText("420")
    const style = chip.getAttribute("style") ?? ""
    expect(style).not.toContain("#22c55e")
    expect(style).toContain("--rpc-text-secondary")
    expect(style).toContain("--rpc-surface-raised")
  })
})

// The bio-dependent quirk kinds (2026-08-15). `classifySerial` has always been
// able to emit jersey_match / birthday_match / draft_year_match, but BOTH of
// its production callers passed only `circulationCount`, so three of its eleven
// kinds were structurally unreachable however correct the pure function was.
// The modal now looks the bio up lazily; these pin that it reaches the
// classifier AND that every failure mode degrades instead of breaking.
describe("MomentDetailModal — player-bio quirk chips", () => {
  const KEY = { editionKey: "5:145" }

  function stubBio(body: unknown, ok = true) {
    const fetchMock = vi.fn(async (_url: string) => ({ ok, json: async () => body }))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shows a jersey-match chip once the bio lookup lands", async () => {
    stubBio({ jerseyNumber: 7, birthdate: null, draftYear: null })
    const { findByText } = render(
      <MomentDetailModal
        moment={moment({ serialNumber: 7, mintSize: 3000, ...KEY })}
        collectionUrlSlug="nba-top-shot"
        onClose={() => {}}
      />
    )
    // Serial 7 is also a meme serial, so assert the chip that can ONLY come
    // from the bio — otherwise this passes with the wiring removed.
    const chip = await findByText("Jersey match")
    expect(chip.getAttribute("title")).toContain("7")
  })

  it("queries the bio arm for this edition, scoped to the collection", async () => {
    const fetchMock = stubBio({ jerseyNumber: 7, birthdate: null, draftYear: null })
    render(
      <MomentDetailModal
        moment={moment({ serialNumber: 7, mintSize: 3000, ...KEY })}
        collectionUrlSlug="nba-top-shot"
        onClose={() => {}}
      />
    )
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain("part=bio")
    expect(url).toContain("editionKey=5%3A145")
    // The bio lives on `editions` scoped by collection_id — an unscoped
    // external_id is not unique across collections.
    expect(url).toContain("collection=nba-top-shot")
  })

  it("shows a draft-year chip and a birthday chip from the same lookup", async () => {
    stubBio({ jerseyNumber: null, birthdate: "1990-07-06", draftYear: 2012 })
    const { findByText } = render(
      <MomentDetailModal
        moment={moment({ serialNumber: 2012, mintSize: 3000, ...KEY })}
        collectionUrlSlug="nba-top-shot"
        onClose={() => {}}
      />
    )
    expect(await findByText("Draft year")).toBeTruthy()

    cleanup()
    stubBio({ jerseyNumber: null, birthdate: "1990-07-06", draftYear: 2012 })
    const second = render(
      <MomentDetailModal
        moment={moment({ serialNumber: 706, mintSize: 3000, ...KEY })}
        collectionUrlSlug="nba-top-shot"
        onClose={() => {}}
      />
    )
    expect(await second.findByText("Birthday")).toBeTruthy()
  })

  it("degrades to the serial-intrinsic chips when the bio read fails", async () => {
    // ⚠ FAIL-SOFT: a 503 must leave the palindrome chip standing, not blank the
    // row and not throw. A missing chip understates; that is the safe direction.
    stubBio({ error: "unavailable" }, false)
    const { findByText, queryByText } = render(
      <MomentDetailModal
        moment={moment({ serialNumber: 1221, mintSize: 3000, ...KEY })}
        collectionUrlSlug="nba-top-shot"
        onClose={() => {}}
      />
    )
    expect(await findByText("Palindrome")).toBeTruthy()
    expect(queryByText("Jersey match")).toBeNull()
  })

  it("does not fetch at all when the caller supplies no editionKey", () => {
    // Every caller that has not been wired up must keep working untouched.
    const fetchMock = stubBio({ jerseyNumber: 7, birthdate: null, draftYear: null })
    render(
      <MomentDetailModal moment={moment({ serialNumber: 7, mintSize: 3000 })} onClose={() => {}} />
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not fetch when the collection slug is missing", () => {
    // An unscoped external_id would resolve the wrong collection's edition.
    const fetchMock = stubBio({ jerseyNumber: 7, birthdate: null, draftYear: null })
    render(
      <MomentDetailModal moment={moment({ serialNumber: 7, mintSize: 3000, ...KEY })} onClose={() => {}} />
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
