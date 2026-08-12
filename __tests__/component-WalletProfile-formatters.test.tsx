// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"
import WalletProfile from "@/components/analytics/WalletProfile"

// The FORMATTER ladders in components/analytics/WalletProfile.tsx — the largest
// remaining uncovered-branch cluster in the component gate (71 branches, 75.2%).
//
// The sibling component-WalletProfile.test.tsx covers behaviour: role
// classification, which panels show, expansion, counterparty extraction. What
// stayed dark is the display layer underneath — five magnitude/date ladders
// whose failure mode is a WRONG NUMBER rather than a crash, on a page whose
// whole purpose is lending money figures.
//
// Two of them are worth stating explicitly, because they are easy to "simplify"
// into something that still renders:
//   • fmtUsd and fmtNumber floor at `n <= 0` -> "$0" / "0". They deliberately do
//     NOT format negatives; a negative principal is not a real state here, and
//     rendering "-$1.2k" would imply one.
//   • fmtPct returns an em-dash for null but "0.00%" for an actual zero. Those
//     mean different things — "no rate recorded" vs "a zero rate" — and
//     collapsing them would report an unknown APR as free money.
//
// The helpers are module-private, so all of it is asserted through the DOM.

vi.mock("@/components/analytics/WalletIdenticon", () => ({
  default: ({ addr }: any) => <div data-testid="identicon">{addr}</div>,
}))
vi.mock("@/lib/analytics/username-resolver", async (orig) => {
  const real = (await orig()) as any
  return { ...real, useResolveUsernames: () => ({}) }
})
vi.mock("next/link", () => ({ default: ({ children, ...p }: any) => <a {...p}>{children}</a> }))

afterEach(() => cleanup())

const loan = (over: Record<string, any> = {}): any => ({
  loan_id: "l-" + (over.loan_id ?? "1"),
  counterparty_addr: "0xcccccccccccccccc",
  principal_usd: 100,
  funded_at: "2026-07-01T00:00:00Z",
  status: "active",
  ...over,
})

function renderWith(over: Record<string, any> = {}) {
  const data: any = {
    addr: "0xaaaaaaaaaaaaaaaa",
    as_borrower: { loan_count: 1, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
    as_lender: { loan_count: 0, total_principal_usd: 0 },
    limbo_as_borrower: { loan_count: 0 },
    limbo_as_lender: { loan_count: 0 },
    recent_as_borrower: [loan({ loan_id: "b1" })],
    recent_as_lender: [],
    ...over,
  }
  return render(<WalletProfile data={data} />)
}

/** Render with a single borrower aggregate value and return the page text. */
function textForUsd(total: number): string {
  const { container, unmount } = renderWith({
    as_borrower: { loan_count: 1, total_principal_usd: total, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
  })
  const t = container.textContent ?? ""
  unmount()
  return t
}

describe("fmtUsd — magnitude ladder", () => {
  it("abbreviates millions, thousands, and keeps cents below $100", () => {
    // Each rung has its own precision: 2dp for M, 1dp for k, 0dp for >=100,
    // 2dp below that. Collapsing any of them changes a displayed loan size.
    expect(textForUsd(2_500_000)).toContain("$2.50M")
    expect(textForUsd(2_500)).toContain("$2.5k")
    expect(textForUsd(250)).toContain("$250")
    expect(textForUsd(2.5)).toContain("$2.50")
  })

  it("floors at $0 for zero, negative, null and non-finite", () => {
    // A negative principal is not a real state on this card; rendering
    // "-$1.2k" would imply one. Same for NaN leaking through as "$NaN".
    for (const v of [0, -1200, null, undefined, NaN, Infinity]) {
      const t = textForUsd(v as number)
      expect(t).toContain("$0")
      expect(t).not.toMatch(/\$NaN|\$Infinity|-\$/)
    }
  })
})

describe("fmtNumber + fmtPct", () => {
  it("abbreviates large loan counts and leaves small ones exact", () => {
    const big = renderWith({
      as_borrower: { loan_count: 2_500_000, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
    })
    expect(big.container.textContent).toContain("2.50M")
    big.unmount()

    const mid = renderWith({
      as_borrower: { loan_count: 2_500, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
    })
    expect(mid.container.textContent).toContain("2.5k")
    mid.unmount()

    const small = renderWith({
      as_borrower: { loan_count: 7, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
    })
    expect(small.container.textContent).toContain("7")
    small.unmount()
  })

  it("never prints NaN for a missing count", () => {
    const { container } = renderWith({
      as_borrower: { loan_count: null, total_principal_usd: null, first_seen_at: null, last_seen_at: null },
    })
    expect(container.textContent).not.toMatch(/NaN|undefined|null/)
  })

  it("distinguishes an UNKNOWN rate (em-dash) from a ZERO rate (0.00%)", () => {
    // These mean different things — "no rate recorded" vs "a zero rate" — and
    // collapsing them reports an unknown APR as free money.
    const zero = renderWith({
      as_lender: { loan_count: 1, total_principal_usd: 100, avg_apr: 0, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
      recent_as_lender: [loan({ loan_id: "s0", interest_rate: 0 })],
    })
    const zeroText = zero.container.textContent ?? ""
    zero.unmount()

    const unknown = renderWith({
      as_lender: { loan_count: 1, total_principal_usd: 100, avg_apr: null, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
      recent_as_lender: [loan({ loan_id: "sN", interest_rate: null })],
    })
    const unknownText = unknown.container.textContent ?? ""
    unknown.unmount()

    expect(zeroText).not.toBe(unknownText)
  })
})

describe("truncateAddress", () => {
  it("truncates a full 0x address in the middle, keeping both ends", () => {
    const { container } = renderWith({ addr: "0xbd94cade097e50ac" })
    const t = container.textContent ?? ""
    // Both ends must survive — a collector identifies a wallet by them.
    expect(t).toContain("0xbd94")
    expect(t).toContain("50ac")
  })

  it("leaves a short or non-0x identifier untouched", () => {
    // Truncating something that is not a full address would mangle a username.
    // Scoped to THIS address: other rows (counterparties) legitimately carry an
    // ellipsis, so a page-wide "no …" assertion would fail for the wrong reason.
    const { container } = renderWith({ addr: "0xabc", recent_as_borrower: [], recent_as_lender: [] })
    const t = container.textContent ?? ""
    expect(t).toContain("0xabc")
    expect(t).not.toContain("0xabc…")
  })
})

describe("fmtRelative — the last-seen ladder", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

  function lastSeenText(iso: string | null): string {
    const { container, unmount } = renderWith({
      as_borrower: { loan_count: 1, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: iso },
    })
    const t = container.textContent ?? ""
    unmount()
    return t
  }

  it("renders every rung of the ladder", () => {
    expect(lastSeenText(ago(10_000))).toContain("just now")
    expect(lastSeenText(ago(5 * MIN))).toContain("5m ago")
    expect(lastSeenText(ago(5 * HOUR))).toContain("5h ago")
    expect(lastSeenText(ago(5 * DAY))).toContain("5d ago")
    expect(lastSeenText(ago(60 * DAY))).toContain("2mo ago")
    expect(lastSeenText(ago(800 * DAY))).toContain("2y ago")
  })

  it("treats a FUTURE timestamp as 'just now' rather than a negative age", () => {
    // Clock skew between the indexer and the reader is routine; "-3m ago" would
    // read as a bug in the data rather than a rounding artifact.
    const t = lastSeenText(new Date(Date.now() + 5 * MIN).toISOString())
    expect(t).toContain("just now")
    expect(t).not.toMatch(/-\d+m ago/)
  })

  it("renders an em-dash for a missing timestamp, never 'Invalid Date'", () => {
    expect(lastSeenText(null)).toContain("—")
    expect(lastSeenText(null)).not.toMatch(/Invalid Date|NaN/)
  })
})

describe("mergeLoans — newest first across both sides", () => {
  it("interleaves borrower and lender loans in descending funded_at order", () => {
    const { container } = renderWith({
      as_lender: { loan_count: 2, total_principal_usd: 200, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
      recent_as_borrower: [
        loan({ loan_id: "old-b", funded_at: "2026-01-01T00:00:00Z", principal_usd: 111 }),
        loan({ loan_id: "new-b", funded_at: "2026-07-01T00:00:00Z", principal_usd: 222 }),
      ],
      recent_as_lender: [loan({ loan_id: "mid-s", funded_at: "2026-04-01T00:00:00Z", principal_usd: 333 })],
    })
    const text = container.textContent ?? ""
    // Newest first: the July borrower loan must appear before the April lender
    // loan, which must appear before the January one.
    const iNew = text.indexOf("$222")
    const iMid = text.indexOf("$333")
    const iOld = text.indexOf("$111")
    expect(iNew).toBeGreaterThanOrEqual(0)
    expect(iNew).toBeLessThan(iMid)
    expect(iMid).toBeLessThan(iOld)
  })

  it("does not crash when funded_at is missing on either side", () => {
    // localeCompare on a null would throw; the helper coerces to "".
    const { container } = renderWith({
      as_lender: { loan_count: 1, total_principal_usd: 100, first_seen_at: "2026-01-01", last_seen_at: "2026-07-01" },
      recent_as_borrower: [loan({ loan_id: "nb", funded_at: null })],
      recent_as_lender: [loan({ loan_id: "nl", funded_at: null })],
    })
    expect(container.textContent).not.toMatch(/NaN|undefined/)
  })
})
