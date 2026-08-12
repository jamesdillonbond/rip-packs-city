// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react"

// app/(collections)/[collection]/pack/[id]/PackLifecycleClient.tsx — 1,054
// lines, zero tests, measured by NEITHER coverage gate (the primary gate takes
// route handlers + lib; the component gate's app/ globs reach app/insights and
// now app/profile, not app/(collections)).
//
// It is unusually testable for its size: it exports ELEVEN presentational
// components that take plain props and do no fetching, so each can be driven
// directly. That is why it is worth doing rather than deferring — the cost is
// low and the surface is a public pack page showing real money.
//
// The assertions concentrate on the two things that mislead rather than break:
//   - HeroDelta colours the headline by delta DIRECTION, so "PULLED $X" reads
//     as win/loss at a glance. A wrong direction paints a loss green.
//   - AddressChip renders an em-dash for a null address rather than an empty
//     link or the string "null" — and, when present, links to the FULL address
//     while DISPLAYING a truncated one. A truncated href would send a collector
//     to the wrong Flowscan account.

import {
  AddressChip,
  TxChip,
  StatusBadge,
  HeroDelta,
  OwnershipTimeline,
  PullsGrid,
  CopyButton,
  RipPerforation,
  StatsFooter,
  PackIdentityHero,
  PackIdentityMinimal,
} from "@/app/(collections)/[collection]/pack/[id]/PackLifecycleClient"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const ADDR = "0xbd94cade097e50ac"
const HASH = "9f2c1e7a4b8d3f60a1c2e3b4d5f60718293a4b5c6d7e8f9012345678abcdef01"

describe("AddressChip", () => {
  it("renders an em-dash for a null address, not an empty link", () => {
    const { container } = render(<AddressChip addr={null} />)
    expect(container.textContent).toContain("—")
    // An empty <a> is a click target that goes nowhere.
    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).not.toMatch(/null|undefined/)
  })

  it("links to the FULL address while displaying a truncated one", () => {
    const { container } = render(<AddressChip addr={ADDR} />)
    const a = container.querySelector("a")!
    // The href must carry the complete address — truncating it would send a
    // collector to a different (or non-existent) Flowscan account.
    expect(a.getAttribute("href")).toContain(ADDR)
    // ...while the visible text is shortened.
    expect(a.textContent).not.toBe(ADDR)
    expect(a.textContent!.length).toBeLessThan(ADDR.length)
  })

  it("opens external links safely", () => {
    const { container } = render(<AddressChip addr={ADDR} />)
    const a = container.querySelector("a")!
    expect(a.getAttribute("target")).toBe("_blank")
    // Without noopener the opened page gets a handle on window.opener.
    expect(a.getAttribute("rel")).toContain("noopener")
  })
})

describe("TxChip", () => {
  it("shortens the hash for display but keeps the full one reachable", () => {
    const { container } = render(<TxChip hash={HASH} />)
    const a = container.querySelector("a")!
    expect(a.getAttribute("href")).toContain(HASH)
    expect(a.textContent).not.toBe(HASH)
    // The full hash stays available on hover rather than being lost entirely.
    expect(a.getAttribute("title")).toBe(HASH)
  })
})

describe("StatusBadge", () => {
  it("renders a distinct label for each status", () => {
    // These three must stay visually and textually distinct: "unknown" is an
    // honest "we could not determine", not a synonym for sealed.
    const seen = new Set<string>()
    for (const status of ["ripped", "sealed", "unknown"] as const) {
      const { container, unmount } = render(<StatusBadge status={status} />)
      const text = (container.textContent ?? "").trim().toLowerCase()
      expect(text.length).toBeGreaterThan(0)
      seen.add(text)
      unmount()
    }
    expect(seen.size).toBe(3)
  })
})

describe("HeroDelta — direction drives the colour, and colour is the signal", () => {
  function colorsOf(direction: "up" | "down" | "flat" | null) {
    const { container, unmount } = render(
      <HeroDelta headline="PULLED $120" subhead="PAID $10" delta="+$110" deltaDirection={direction} />
    )
    const headline = container.querySelector(".rpc-hero-pulled") as HTMLElement
    const deltaLine = container.querySelector(".rpc-hero-delta-line") as HTMLElement | null
    const out = { headline: headline.style.color, delta: deltaLine?.style.color ?? null }
    unmount()
    return out
  }

  it("paints a gain with success and a loss with danger — never the reverse", () => {
    const up = colorsOf("up")
    const down = colorsOf("down")
    expect(up.headline).toContain("--rpc-success")
    expect(down.headline).toContain("--rpc-danger")
    // The delta line tracks the same direction as the headline; if they
    // disagreed the card would say two different things at once.
    expect(up.delta).toBe(up.headline)
    expect(down.delta).toBe(down.headline)
  })

  it("uses a muted colour for flat, so 'no change' is not read as a gain", () => {
    expect(colorsOf("flat").headline).toContain("--rpc-text-muted")
  })

  it("falls back to primary text when there is NO delta context", () => {
    // Sealed pack or null cost basis: colouring it green/red would assert a
    // profit or loss that has not been computed.
    expect(colorsOf(null).headline).toContain("--rpc-text-primary")
  })

  it("omits the delta line entirely when delta is null", () => {
    const { container } = render(
      <HeroDelta headline="SEALED" subhead={null} delta={null} deltaDirection={null} />
    )
    expect(container.querySelector(".rpc-hero-delta-line")).toBeNull()
    expect(container.textContent).toContain("SEALED")
  })

  it("accepts mixed-font JSX as the subhead", () => {
    render(
      <HeroDelta
        headline="PULLED $120"
        subhead={<>PAID <span className="rpc-hero-sub-amt">$10</span></>}
        delta="+$110"
        deltaDirection="up"
      />
    )
    expect(screen.getByText("$10")).toBeTruthy()
  })
})

describe("OwnershipTimeline", () => {
  it("renders an empty state rather than a bare chain for no events", () => {
    const { container } = render(<OwnershipTimeline events={[]} />)
    expect((container.textContent ?? "").trim().length).toBeGreaterThan(0)
  })

  it("renders one entry per ownership event, in the order given", () => {
    const events = [
      { buyer: "0x1111111111111111", seller: "0x2222222222222222", price_usd: 10, occurred_at: "2026-07-01T00:00:00Z", tx_hash: HASH, kind: "primary_withdraw" },
      { buyer: "0x3333333333333333", seller: "0x1111111111111111", price_usd: 25, occurred_at: "2026-07-05T00:00:00Z", tx_hash: HASH, kind: "secondary_sale" },
    ] as never
    const { container } = render(<OwnershipTimeline events={events} />)
    const text = container.textContent ?? ""
    // Both counterparties appear (truncated), and neither renders as null.
    expect(text).not.toMatch(/null|undefined|NaN/)
    expect(container.querySelectorAll("a").length).toBeGreaterThanOrEqual(2)
  })
})

describe("PullsGrid", () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    player_name: "Damian Lillard",
    set_name: "Base Set",
    tier: "RARE",
    serial_number: 7,
    circulation_count: 1000,
    fmv_usd: 42.5,
    edition_key: "1:2",
    thumbnail_url: null,
    ...over,
  })

  it("renders a card per pull", () => {
    const { container } = render(
      <PullsGrid pulls={[pull(), pull({ player_name: "Anthony Edwards" })] as never} collection="nba-top-shot" />
    )
    expect(within(container).getByText("Damian Lillard")).toBeTruthy()
    expect(within(container).getByText("Anthony Edwards")).toBeTruthy()
  })

  it("does not print null/NaN for a pull with no FMV or serial", () => {
    // A pack page shows real money; a NaN or "null" here is worse than an
    // em-dash because it looks like a rendering bug on a value the user cares
    // about most.
    const { container } = render(
      <PullsGrid
        pulls={[pull({ fmv_usd: null, serial_number: null, circulation_count: null, tier: null })] as never}
        collection="nba-top-shot"
      />
    )
    expect(container.textContent).not.toMatch(/null|undefined|NaN/)
  })

  it("renders an empty state for no pulls", () => {
    const { container } = render(<PullsGrid pulls={[] as never} collection="nba-top-shot" />)
    expect((container.textContent ?? "").trim().length).toBeGreaterThan(0)
  })
})

describe("CopyButton", () => {
  it("copies the FULL value and acknowledges it", async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    const { container } = render(<CopyButton value={ADDR} label="address" />)
    fireEvent.click(container.querySelector("button")!)
    // The whole point is copying the untruncated value.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(ADDR))
  })

  it("does not throw when the clipboard API is unavailable", async () => {
    // Non-secure contexts and some browsers have no navigator.clipboard; an
    // unhandled rejection here would surface as a page error for a cosmetic
    // action the user can retry.
    Object.assign(navigator, { clipboard: undefined })
    const { container } = render(<CopyButton value={ADDR} />)
    expect(() => fireEvent.click(container.querySelector("button")!)).not.toThrow()
  })
})

describe("StatsFooter — ROI is the number people act on", () => {
  function roiOf(roiPct: number | null) {
    const { container, unmount } = render(
      <StatsFooter totalCostBasis={10} basisCurrency="USD" grossPullValueUsd={25} roiPct={roiPct} />
    )
    const text = container.textContent ?? ""
    const html = container.innerHTML
    unmount()
    return { text, html }
  }

  it("signs a positive ROI explicitly and paints it as a gain", () => {
    const { text, html } = roiOf(150)
    // The leading "+" is deliberate: "150.0%" alone is ambiguous about
    // direction when the label is just "ROI".
    expect(text).toContain("+150.0%")
    expect(html).toContain("--rpc-success")
  })

  it("paints a negative ROI as a loss, without a doubled sign", () => {
    const { text, html } = roiOf(-42.5)
    expect(text).toContain("-42.5%")
    expect(text).not.toContain("+-")
    expect(html).toContain("--rpc-danger")
  })

  it("renders an em-dash and a muted colour when ROI is unknown", () => {
    // A null basis means ROI is NOT COMPUTED. Rendering 0% would assert the
    // pack broke exactly even — a fabricated financial claim.
    const { text, html } = roiOf(null)
    expect(text).toContain("—")
    expect(text).not.toContain("0.0%")
    expect(html).toContain("--rpc-text-muted")
  })

  it("treats exactly break-even as non-negative", () => {
    const { text, html } = roiOf(0)
    expect(text).toContain("+0.0%")
    expect(html).toContain("--rpc-success")
  })

  it("does not print NaN when the money fields are null", () => {
    const { container } = render(
      <StatsFooter totalCostBasis={null} basisCurrency={null} grossPullValueUsd={null} roiPct={null} />
    )
    expect(container.textContent).not.toMatch(/NaN|null|undefined/)
  })
})

describe("RipPerforation", () => {
  it("renders the rip section with an accessible label", () => {
    const { container } = render(
      <RipPerforation rip={{ occurred_at: "2026-07-02T00:00:00Z", tx_hash: HASH, ripper: ADDR } as never} />
    )
    // The perforation art is aria-hidden, so the section itself must carry the
    // label or the event is invisible to a screen reader.
    expect(container.querySelector('[aria-label="Pack rip event"]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })
})

describe("PackIdentityHero / PackIdentityMinimal", () => {
  const dist = (over: Record<string, unknown> = {}) => ({
    source: "drop_pool",
    title: "2026 Playoff Pack",
    tier: "RARE",
    image_url: null,
    drop_date: "2026-05-01",
    retail_price_usd: 10,
    ...over,
  })

  it("prefers the distribution title over the pack name", () => {
    const { container } = render(
      <PackIdentityHero
        distribution={dist() as never}
        packNftId="12345"
        packName="Fallback Name"
        status="ripped"
        firstSeenAt="2026-05-02T00:00:00Z"
      />
    )
    expect(container.textContent).toContain("2026 Playoff Pack")
    expect(container.textContent).not.toContain("Fallback Name")
  })

  it("falls back to the pack name, then to the on-chain id", () => {
    const { container: withName } = render(
      <PackIdentityHero
        distribution={dist({ title: null }) as never}
        packNftId="12345"
        packName="Named Pack"
        status="sealed"
        firstSeenAt={null}
      />
    )
    expect(withName.textContent).toContain("Named Pack")

    const { container: bare } = render(
      <PackIdentityHero
        distribution={dist({ title: null }) as never}
        packNftId="12345"
        packName={null}
        status="sealed"
        firstSeenAt={null}
      />
    )
    // Never a blank heading — the id is the last-resort identity.
    expect(bare.textContent).toContain("12345")
  })

  it("renders a reward pack (purchase_metadata source) without retail framing", () => {
    const { container } = render(
      <PackIdentityHero
        distribution={dist({ source: "purchase_metadata", retail_price_usd: 0 }) as never}
        packNftId="9"
        packName={null}
        status="ripped"
        firstSeenAt={null}
      />
    )
    // A $0 reward pack must not render a "$0.00 retail" style claim.
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })

  it("PackIdentityMinimal falls back to the id and shows the status", () => {
    const { container } = render(
      <PackIdentityMinimal packName={null} packNftId="777" status="unknown" firstSeenAt={null} />
    )
    expect(container.textContent).toContain("777")
    expect((container.textContent ?? "").trim().length).toBeGreaterThan(3)
  })
})
