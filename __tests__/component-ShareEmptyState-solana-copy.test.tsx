// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }))

import ShareEmptyState from "@/app/share/[wallet]/ShareEmptyState"

// 2026-11-14 (fresh-eyes review of the share surfaces): a Candy (Solana) key lands in the
// "retry" branch (this flow can only queue a Flow walk), whose heading said "We haven't indexed
// this wallet yet" — a claim about our index made without checking.
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("ShareEmptyState — a Solana address is not told it is unindexed", () => {
  it("says nothing about our index for a base58 address", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    const { container } = render(<ShareEmptyState wallet="7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" />)
    expect(container.textContent).not.toContain("We haven’t indexed this wallet yet")
    expect(container.textContent).toContain("We couldn’t find any moments for this wallet")
  })
})
