// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}))

import WalletSearch from "@/components/WalletSearch"

// A failed wallet search must not report the wallet as NOT FOUND.
//
// ── HOW THIS WAS FOUND, AND THE CORRECTION THAT MATTERS ─────────────────────
// The sibling BAN (client-raw-json-parse-ratchet) only sees `.then()` chains.
// It is structurally blind to the IMPERATIVE shape:
//
//     const res = await fetch(url)
//     const data = await res.json()
//
// A first scan for that shape reported **34 sites across 23 files**. That number
// was a SCANNER ARTIFACT: it required the `res.ok` check to appear BETWEEN the
// fetch and the parse, and 31 of those sites check it immediately AFTER — which
// is legitimate, and arguably better, because parsing first lets the caller
// surface the server's own message. Re-measured with the window covering the
// whole block: **3**, of which 2 were real. Building a ratchet at 34 would have
// been theatre; a pattern count finds candidates, never defects.
//
// ── THE TWO REAL ONES ───────────────────────────────────────────────────────
// `components/WalletSearch.tsx` and `app/share/[wallet]/ShareEmptyState.tsx`
// share this shape verbatim:
//
//     const data = await res.json().catch(() => null)
//     const addr = data?.walletAddress
//     if (addr && FLOW_ADDRESS.test(addr)) { navigate; return }
//     setError(data?.error || "Couldn't find that. Try a Flow wallet address (0x…).")
//
// On a non-2xx the envelope parses, `walletAddress` is absent, and control falls
// through to that last line. It does two wrong things at once: it asserts the
// wallet does NOT EXIST, and it tells the reader to CHANGE WHAT THEY TYPED —
// the "diagnoses a cause it cannot know" shape this repo has fixed before
// ("Benchmark data may be too thin", "try a longer time range").
//
// ⚠ The third site (`app/alerts/page.tsx` suggestion typeahead) is deliberately
// left alone. It sets `setSuggestions([])` on failure, and an empty autocomplete
// asserts nothing — suppressing suggestions is the correct behaviour, not a
// defect. It is NOT an allowlist entry; it is a different thing.

const errorEnvelope = {
  ok: false,
  status: 503,
  json: async () => ({ error: "Service temporarily unavailable", code: "unavailable" }),
}
/** A 404-ish "we looked and there is no such wallet" — a REAL answer. */
const notFound = { ok: true, status: 200, json: async () => ({ walletAddress: null }) }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function submit(value: string) {
  const input = screen.getByRole("textbox") as HTMLInputElement
  fireEvent.change(input, { target: { value } })
  const form = input.closest("form")
  if (form) fireEvent.submit(form)
  else fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
}

describe("WalletSearch — an outage is not a missing wallet", () => {
  it("a 503 does NOT claim the wallet was not found, and does not blame the input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorEnvelope as any))
    render(<WalletSearch surface="test" />)
    submit("someusername")

    await waitFor(() => expect(screen.getByText(/Couldn't search just now/)).toBeTruthy())
    // The claim itself must be absent — not merely accompanied by an error.
    expect(screen.queryByText(/Couldn't find that/)).toBeNull()
    // ...and the failure copy must not advise a fix it cannot know is needed.
    const el = screen.getByText(/Couldn't search just now/)
    expect(el.textContent ?? "").not.toMatch(/Try a Flow wallet address|check the spelling|try a different/i)
  })

  it("a genuine miss STILL says not found — the copy survives", async () => {
    // The other direction. Turning every miss into "couldn't search" would only
    // move the dishonesty, and this copy is correct when the read succeeded.
    vi.stubGlobal("fetch", vi.fn(async () => notFound as any))
    render(<WalletSearch surface="test" />)
    submit("definitelynotarealuser")

    await waitFor(() => expect(screen.getByText(/Couldn't find that/)).toBeTruthy())
    expect(screen.queryByText(/Couldn't search just now/)).toBeNull()
  })
})

describe("both wallet-search sites carry the status check", () => {
  it("ShareEmptyState has the same guard, ordered before the parse", async () => {
    // Asserted at source: this component redirects on success and is awkward to
    // drive twice in jsdom, but the property is identical and the two files
    // drifted apart once already by being fixed separately.
    const { readFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const src = readFileSync(join(process.cwd(), "app/share/[wallet]/ShareEmptyState.tsx"), "utf8")

    // ⚠ Written first as `indexOf(guard) < indexOf(parse)` — and it FAILED
    // against correct code. My first explanation for that was also wrong, so
    // both are recorded: I assumed the GUARD recurred, and it does not (exactly
    // one occurrence). It is the PARSE that appears twice — this file has a
    // second, unrelated fetch block at line 53 whose identical parse line sits
    // ~1800 chars EARLIER, so indexOf compared the new guard against the other
    // block's parse.
    //
    // Same vacuous-ordering trap recorded a few commits earlier, reached again
    // while the comment warning about it was on screen — and the lesson is
    // slightly wider than it was stated there: it is enough for EITHER needle to
    // recur. Contiguity sidesteps the question: guard, then parse, nothing
    // between.
    const guardThenParse =
      "if (!res.ok) {\n" +
      '        setError("Couldn\'t search just now — this says nothing about that wallet. Try again shortly.");\n' +
      "        return;\n" +
      "      }\n" +
      "      const data = await res.json().catch(() => null);"
    expect(src).toContain(guardThenParse)
    // The honest not-found copy survives here too.
    expect(src).toContain("Couldn't find that. Try a Flow wallet address")
  })
})
