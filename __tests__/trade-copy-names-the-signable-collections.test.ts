import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SWAP_COLLECTIONS } from "@/lib/trade-room/multi-swap-cadence"

// 2026-11-02: the trade room grew from Top Shot to All Day, Golazos and UFC in one afternoon,
// and four surfaces kept saying "Top Shot" — the CONCIERGE's own rules among them (it also
// still said signing "opens once the live test has sealed", eight days after it opened). A
// collector asking the concierge "can I trade my UFC?" would have been told no.
//
// So every surface that tells a collector WHAT can be traded must name exactly the
// collections the swap moves (SWAP_COLLECTIONS — the list the Cadence is built from), and the
// concierge must say what cannot (Pinnacle pins, packs). Adding a collection to the swap reds
// this until the copy says so.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/** The passage on each surface that tells a collector what can be traded — not the whole file,
 *  which names these collections elsewhere for other reasons (a whole-file check passed a
 *  planted "Swap Top Shot Moments" regression on the dashboard). */
const passage = (src: string, from: string, to: string | null): string => {
  const i = src.indexOf(from)
  if (i < 0) return ""
  const j = to ? src.indexOf(to, i + from.length) : src.indexOf("\n", i)
  return src.slice(i, j < 0 ? undefined : j)
}

const SURFACES: Array<[string, string, string, string | null, (c: (typeof SWAP_COLLECTIONS)[number]) => string]> = [
  ["/trades", "app/trades/TradesListClient.tsx", "Swap NBA Top Shot", null, (c) => c.label],
  ["/trades metadata", "app/trades/layout.tsx", "Trade NBA Top Shot", null, (c) => c.label],
  ["the help page", "app/help/page.tsx", "Can I trade Moments", "q:", (c) => c.label],
  ["the Trade Block browse page", "app/trades/block/BlockBrowseClient.tsx", "What collectors would trade", "</p>", (c) => c.label],
  // The dashboard "Trade Moments" card was removed 2026-11-06 (IA Phase 1): the
  // dashboard now carries a one-word "Trades" link with no trading passage to
  // check, so there is no copy there that could name the collections wrongly.
]

describe("trade copy names exactly the collections the swap can move", () => {
  it.each(SURFACES)("%s names every signable collection in its trading passage", (_label, file, from, to, name) => {
    const text = passage(read(file), from, to)
    expect(text.length, `${file}: the passage starting "${from}" is gone — re-point this guard`).toBeGreaterThan(40)
    for (const c of SWAP_COLLECTIONS) expect(text, `${file} should name ${name(c)}`).toContain(name(c))
  })

  it("the concierge's trade rule says what cannot be traded, and does not describe the signing step as unopened", () => {
    const src = read("app/api/support-chat/route.ts")
    const rule = src.slice(src.indexOf("a signed-in collector can swap"), src.indexOf("There is no in-app buying"))
    expect(rule.length).toBeGreaterThan(100)
    expect(rule).toMatch(/Disney Pinnacle pins and packs[^.]*CANNOT be traded/)
    expect(rule).not.toMatch(/once RPC's live two-wallet test has sealed/)
    for (const c of SWAP_COLLECTIONS) expect(rule).toContain(c.label)
  })
})
