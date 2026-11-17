// @vitest-environment jsdom
//
// __tests__/component-EarlyAccessClient.test.tsx
//
// The signup form. Two things here are worth a gate:
//
// 1. THE VALIDATION DECIDES WHETHER A SIGNUP IS USABLE AT ALL. The wallet or
//    username is what lets us pre-warm a collection, so a submission carrying
//    neither is a row nobody can act on. The form blocks it — and the block has
//    to stay a BLOCK rather than drifting into a warning, because the failure
//    is invisible after the fact.
//
// 2. THE ON-CHAIN NUDGE MUST NEVER BLOCK. Two of the first organic signups
//    typed a wrong wallet and needed manual SQL to fix, which is what the nudge
//    exists for — but a Golazos/UFC-only collector legitimately holds 0 Top Shot
//    moments, so treating "0 moments" as invalid would reject real collectors.
//    It is advisory by design, and several cases below pin that it stays so.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react"

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import EarlyAccessClient from "@/app/early-access/EarlyAccessClient"

const VALID_WALLET = "0xbd94cade097e50ac"

const emailBox = () => screen.getByPlaceholderText("you@example.com") as HTMLInputElement
const walletBox = () => screen.getByPlaceholderText("0x1234567890abcdef") as HTMLInputElement
const usernameBox = () => screen.getByPlaceholderText("e.g. yourusername") as HTMLInputElement
const submit = () => screen.getByRole("button", { name: /save my details/i }) as HTMLButtonElement

/** The submit call's parsed JSON body, or null if it never fired. */
function submittedBody(): Record<string, unknown> | null {
  const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/early-access/submit")
  if (!call) return null
  return JSON.parse(String((call[1] as RequestInit).body))
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input) === "/api/early-access/submit") {
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    }
    // /api/wallet-search — a wallet that holds moments, so the nudge stays quiet
    return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 42 } }) }
  })
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** Fill the minimum a valid submission needs. */
function fillValid() {
  fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
  fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
}

describe("EarlyAccessClient — what makes a submission valid", () => {
  it("blocks submit until an email is present", () => {
    render(<EarlyAccessClient />)
    expect(submit().disabled).toBe(true)
  })

  it("still blocks with an email but NO identifier at all", () => {
    // ⚠ This is the case the form exists to prevent: an email with neither a
    // wallet nor a username is a signup we cannot pre-warm, and nothing
    // downstream can recover the missing identifier.
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })

    expect(submit().disabled).toBe(true)
    expect(screen.getByText(/Add either a Flow wallet address or a username/i)).toBeTruthy()
  })

  it("a USERNAME alone is sufficient — a wallet is not required", () => {
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(usernameBox(), { target: { value: "someHandle" } })

    expect(submit().disabled).toBe(false)
  })

  it("a WALLET alone is sufficient — a username is not required", () => {
    render(<EarlyAccessClient />)
    fillValid()
    expect(submit().disabled).toBe(false)
  })

  it("a malformed wallet blocks submit and says exactly what is wrong", () => {
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(walletBox(), { target: { value: "0xnothex" } })

    expect(submit().disabled).toBe(true)
    expect(screen.getByText(/0x \+ 16 hex characters/i)).toBeTruthy()
    expect(walletBox().getAttribute("aria-invalid")).toBe("true")
  })

  it("rejects a wallet of the WRONG LENGTH, not merely wrong characters", () => {
    // A Flow address is exactly 16 hex chars. A 15- or 17-char string is all
    // hex and still not an address, so a naive /^0x[a-f0-9]+$/ would pass it.
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(walletBox(), { target: { value: "0xbd94cade097e50a" } }) // 15
    expect(submit().disabled).toBe(true)

    fireEvent.change(walletBox(), { target: { value: "0xbd94cade097e50acc" } }) // 17
    expect(submit().disabled).toBe(true)
  })

  it("accepts an UPPERCASE hex wallet", () => {
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(walletBox(), { target: { value: "0xBD94CADE097E50AC" } })
    expect(submit().disabled).toBe(false)
  })
})

describe("EarlyAccessClient — the submitted payload", () => {
  it("lowercases the email and sends the collections chosen", async () => {
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "  A@B.CoM " } })
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.click(screen.getByRole("button", { name: "NBA Top Shot" }))
    fireEvent.click(screen.getByRole("button", { name: "UFC Strike" }))
    fireEvent.click(submit())

    await waitFor(() => expect(submittedBody()).not.toBeNull())
    expect(submittedBody()).toMatchObject({
      email: "a@b.com",
      wallet: VALID_WALLET,
      collections: ["nba_top_shot", "ufc_strike"],
    })
  })

  it("sends NULL rather than an empty string for an omitted identifier — BOTH fields", async () => {
    // ⚠ "" and null are different rows to a lookup: an empty string is a value
    // that can be matched against and found absent, and it defeats a NOT NULL /
    // COALESCE fill-only heal downstream. Absent must mean absent.
    //
    // ⚠ BOTH DIRECTIONS ARE NEEDED. A wallet-only fixture can only observe the
    // USERNAME's `|| null`, because a supplied wallet makes `x.trim()` and
    // `x.trim() || null` identical — the wallet mutation survived on exactly
    // that. The username-only case below is what makes the wallet's fallback
    // observable, and vice versa.
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    await waitFor(() => expect(submittedBody()).not.toBeNull())
    expect(submittedBody()!.username).toBeNull()
    expect(submittedBody()!.wallet).toBe(VALID_WALLET)
  })

  it("sends a null WALLET when the user identified themselves by username", async () => {
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(usernameBox(), { target: { value: "someHandle" } })
    fireEvent.click(submit())

    await waitFor(() => expect(submittedBody()).not.toBeNull())
    expect(submittedBody()!.wallet).toBeNull()
    expect(submittedBody()!.username).toBe("someHandle")
  })

  it("toggling a collection off removes it again", async () => {
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(screen.getByRole("button", { name: "NBA Top Shot" }))
    fireEvent.click(screen.getByRole("button", { name: "NBA Top Shot" }))
    fireEvent.click(submit())

    await waitFor(() => expect(submittedBody()).not.toBeNull())
    expect(submittedBody()!.collections).toEqual([])
  })

  it("says an empty selection pre-warms ALL five, not none", () => {
    // An empty multi-select reads naturally as "nothing", which would be a
    // reason not to submit. The copy has to say the opposite is true.
    render(<EarlyAccessClient />)
    expect(screen.getByText(/Skip to pre-warm all five collections/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "NBA Top Shot" }))
    expect(screen.getByText(/Pre-warming this collection only/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "UFC Strike" }))
    expect(screen.getByText(/Pre-warming 2 collections only/i)).toBeTruthy()
  })
})

describe("EarlyAccessClient — the outcome states", () => {
  it("a fresh signup renders the success card", async () => {
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText(/You're all set/i)).toBeTruthy()
    expect(screen.getByText(/pre-warming your collection now/i)).toBeTruthy()
  })

  it("a DUPLICATE is reported as already-set-up, not as a failure", async () => {
    // ⚠ A repeat signup is a success, not an error. Telling a returning user
    // that their submission failed makes them submit again — or conclude the
    // product is broken — when in fact they are already in.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/early-access/submit") {
        return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: true }) }
      }
      return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 1 } }) }
    })
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText(/Already set up/i)).toBeTruthy()
    expect(screen.getByText(/We already have your details/i)).toBeTruthy()
  })

  it("a non-2xx surfaces the server's reason", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/early-access/submit") {
        return { ok: false, status: 500, json: async () => ({ error: "Signup is temporarily unavailable" }) }
      }
      return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 1 } }) }
    })
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText(/Signup is temporarily unavailable/i)).toBeTruthy()
    // ⚠ The form must SURVIVE a failure — replacing it with the success card,
    // or blanking it, loses everything the user typed and gives them nothing
    // to retry with.
    expect(emailBox().value).toBe("a@b.com")
  })

  it("treats ok:false at HTTP 200 as a failure, not a success", async () => {
    // The route can answer 200 with { ok: false }. Branching on res.ok alone
    // renders "You're all set" over a signup that was never recorded.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/early-access/submit") {
        return { ok: true, status: 200, json: async () => ({ ok: false, error: "rejected upstream" }) }
      }
      return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 1 } }) }
    })
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText(/rejected upstream/i)).toBeTruthy()
    expect(screen.queryByText(/You're all set/i)).toBeNull()
  })

  it("a thrown fetch reports something rather than hanging on 'Submitting…'", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/early-access/submit") throw new Error("offline")
      return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 1 } }) }
    })
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText("offline")).toBeTruthy()
    expect(submit().textContent).toMatch(/Save my details/i)
  })

  it("a non-JSON error body still yields a message rather than 'undefined'", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/early-access/submit") {
        return { ok: false, status: 502, json: async () => { throw new Error("not json") } }
      }
      return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 1 } }) }
    })
    render(<EarlyAccessClient />)
    fillValid()
    fireEvent.click(submit())

    expect(await screen.findByText(/HTTP 502/i)).toBeTruthy()
  })
})

describe("EarlyAccessClient — the on-chain nudge is advisory and must stay so", () => {
  it("warns on a well-formed wallet holding ZERO moments", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 0 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())

    expect(await screen.findByText(/shows 0 Top Shot moments on-chain/i)).toBeTruthy()
  })

  it("the warning does NOT block submission", async () => {
    // ⚠ THE LOAD-BEARING HALF. A Golazos- or UFC-only collector really does
    // hold 0 Top Shot moments, so a hard block here would turn away exactly the
    // multi-collection users the product is for. It says so in the copy too.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 0 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(emailBox(), { target: { value: "a@b.com" } })
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())
    await screen.findByText(/shows 0 Top Shot moments/i)

    expect(submit().disabled).toBe(false)
    expect(screen.getByText(/Golazos\/UFC-only collectors can ignore this/i)).toBeTruthy()

    fireEvent.click(submit())
    expect(await screen.findByText(/You're all set/i)).toBeTruthy()
  })

  it("does not probe at all for a malformed wallet", async () => {
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: "0xnope" } })
    fireEvent.blur(walletBox())

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/wallet-search")).toBe(false)
    })
  })

  it("clears a stale warning as soon as the field is edited", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return { ok: true, status: 200, json: async () => ({ summary: { totalMoments: 0 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())
    await screen.findByText(/shows 0 Top Shot moments/i)

    // A warning about the OLD address, left on screen beside a NEW one, is a
    // claim about a wallet the user is no longer entering.
    //
    // ⚠ EDIT TO ANOTHER *VALID* WALLET. The warning renders behind
    // `walletValid && walletWarning`, so editing to a malformed value hides it
    // via the VALIDITY gate and the case passes with the onChange clear
    // deleted — which is how this mutation first survived. Only a still-valid
    // replacement isolates the clear as the mechanism.
    fireEvent.change(walletBox(), { target: { value: "0x1111111111111111" } })
    expect((walletBox() as HTMLInputElement).getAttribute("aria-invalid")).toBe("false")
    expect(screen.queryByText(/shows 0 Top Shot moments/i)).toBeNull()
  })

  it("a failed probe fails SILENT — no warning invented from our own outage", async () => {
    // ⚠ The nudge asserts something about the USER'S wallet. Rendering it when
    // the lookup failed would blame the user's address for our outage, and it
    // is unfalsifiable to them: they cannot tell a real 0 from a failed read.
    //
    // ⚠ THE 503 CARRIES A ZEROED SUMMARY DELIBERATELY. An empty `{}` body makes
    // this case pass with the `!res.ok` guard DELETED, because `totalMoments`
    // is then undefined and the `typeof tm === "number"` check blocks it — the
    // mutation survived on exactly that fixture. A failing endpoint answering
    // with its default-shaped payload is the realistic case, and it is the one
    // where the status check is the only thing standing between our outage and
    // a false claim about the user's wallet.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return { ok: false, status: 503, json: async () => ({ summary: { totalMoments: 0 } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/wallet-search")).toBe(true)
    })
    expect(screen.queryByText(/shows 0 Top Shot moments/i)).toBeNull()
  })

  it("a THROWN probe also fails silent", async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") throw new Error("aborted")
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/wallet-search")).toBe(true)
    })
    expect(screen.queryByText(/shows 0 Top Shot moments/i)).toBeNull()
  })

  it("a non-numeric moment count is not treated as zero", async () => {
    // `undefined === 0` is false, but a `!tm` spelling would fire the warning
    // on a payload shape change — inventing a claim from a schema drift.
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return { ok: true, status: 200, json: async () => ({ summary: {} }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/wallet-search")).toBe(true)
    })
    expect(screen.queryByText(/shows 0 Top Shot moments/i)).toBeNull()
  })

  it("drops a result that lands after the field changed", async () => {
    // ⚠ The probe is fired on blur and the user can keep typing. Without the
    // `wallet.trim() === w` recheck, a slow answer about the PREVIOUS address
    // renders as a verdict on the current one.
    let settle: () => void = () => {}
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === "/api/wallet-search") {
        return new Promise((r) => {
          settle = () => r({ ok: true, status: 200, json: async () => ({ summary: { totalMoments: 0 } }) })
        })
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, duplicate: false }) }
    })
    render(<EarlyAccessClient />)
    fireEvent.change(walletBox(), { target: { value: VALID_WALLET } })
    fireEvent.blur(walletBox())
    // The user edits before the answer arrives.
    fireEvent.change(walletBox(), { target: { value: "0x1111111111111111" } })
    settle()

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/wallet-search")).toBe(true)
    })
    expect(screen.queryByText(/shows 0 Top Shot moments/i)).toBeNull()
  })
})
