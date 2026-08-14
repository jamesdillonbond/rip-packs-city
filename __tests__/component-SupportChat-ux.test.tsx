// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SupportChat from "@/components/SupportChat"

// Covers the 2026-08-13 concierge UX pass:
//
//  * links — the bubble rendered `{msg.text}` as one raw string, so every board
//    URL the bot is told to "hand out freely" arrived as inert text the user
//    had to retype. Now tokenized into real anchors.
//  * theme — the panel hardcoded #0d0d0d / #141414 / #ccc while the site has a
//    user-facing light theme (ThemeToggle sets data-theme="light"), so a
//    light-mode user got a black panel with grey text. Now reads tokens.
//  * a11y — role=dialog, an aria-live region so a screen reader hears the
//    streamed reply, Escape to close, and focus returned to the launcher. Five
//    other overlays already did all of this; the chat was the outlier.

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

const ctxRes = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) } as unknown as Response)

function streamRes(textPart: string, meta?: unknown) {
  const enc = new TextEncoder()
  const payload = meta === undefined ? textPart : textPart + "\x1e" + JSON.stringify(meta)
  const body = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(payload))
      c.close()
    },
  })
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === "x-rpc-stream" ? "1" : null) },
    body,
    json: () => Promise.resolve({}),
  } as unknown as Response)
}

function routeFetch(chat: (body: any) => Promise<Response>) {
  return vi.fn((url: string, init?: any) => {
    if (url.includes("/api/support-chat/context")) return ctxRes()
    if (url.includes("/api/support-chat/feedback"))
      return Promise.resolve({ status: 200, headers: { get: () => null }, json: () => Promise.resolve({ ok: true }) } as unknown as Response)
    return chat(init?.body ? JSON.parse(init.body) : {})
  })
}

beforeEach(() => {
  trackMock.mockClear()
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function openAndSend(msg: string, reply: string) {
  vi.stubGlobal("fetch", routeFetch(() => streamRes(reply)))
  const utils = render(<SupportChat />)
  fireEvent.click(utils.getByLabelText("Open RPC concierge"))
  const input = await waitFor(() => utils.getByPlaceholderText(/Ask a question/))
  fireEvent.change(input, { target: { value: msg } })
  fireEvent.click(utils.getByLabelText("Send"))
  return utils
}

describe("SupportChat — the bot's links are clickable", () => {
  it("renders a site-relative board path the bot hands out as a real anchor", async () => {
    const { container } = await openAndSend("where are the deals", "The board lives at /insights/deals right now.")
    const link = await waitFor(() => {
      const a = container.querySelector('a[href="/insights/deals"]')
      if (!a) throw new Error("no anchor")
      return a as HTMLAnchorElement
    })
    expect(link.textContent).toBe("/insights/deals")
    // Internal link: same tab, so the user keeps their session context.
    expect(link.getAttribute("target")).toBeNull()
  })

  it("renders a markdown link with its label and opens external targets safely", async () => {
    const { container } = await openAndSend("link me", "See [Top Shot](https://nbatopshot.com/moment/1) for the listing.")
    const link = await waitFor(() => {
      const a = container.querySelector('a[href="https://nbatopshot.com/moment/1"]')
      if (!a) throw new Error("no anchor")
      return a as HTMLAnchorElement
    })
    expect(link.textContent).toBe("Top Shot")
    expect(link.getAttribute("target")).toBe("_blank")
    // noopener is what stops the opened tab reaching back via window.opener.
    expect(link.getAttribute("rel")).toContain("noopener")
  })

  // The security property. Model output quotes tool results, which carry
  // values RPC does not control, so a hostile scheme must never become a
  // clickable anchor — it degrades to visible text instead.
  it("never turns a javascript: target into an anchor", async () => {
    const { container, getByText } = await openAndSend("hostile", "Try [click me](javascript:alert(1)) now")
    await waitFor(() => expect(getByText(/click me/)).toBeTruthy())
    expect(container.querySelector("a")).toBeNull()
  })

  it("does not linkify the user's own message back at them", async () => {
    const { container } = await openAndSend("check /insights/deals for me", "Sure.")
    await waitFor(() => expect(container.textContent).toContain("Sure."))
    // The only anchors present come from the assistant, and this reply has none.
    expect(container.querySelector("a")).toBeNull()
  })
})

describe("SupportChat — theme", () => {
  it("paints the panel from theme tokens, not hardcoded dark hex", async () => {
    const { container } = await openAndSend("hi", "hello")
    const panel = await waitFor(() => {
      const p = container.querySelector('[role="dialog"]')
      if (!p) throw new Error("no panel")
      return p as HTMLElement
    })
    // The literal the panel used to hardcode. A light-mode user got this as a
    // black slab regardless of their theme choice.
    expect(panel.style.background).toContain("--rpc-surface")
    expect(panel.style.background).not.toContain("#0d0d0d")
    expect(panel.style.border).toContain("--rpc-border")
  })

  it("paints the input row and send button from tokens", async () => {
    const { getByPlaceholderText } = await openAndSend("hi", "hello")
    const input = getByPlaceholderText(/Ask a question/) as HTMLInputElement
    expect(input.style.background).toContain("--rpc-surface-raised")
    expect(input.style.color).toContain("--rpc-text-primary")
  })
})

describe("SupportChat — accessibility", () => {
  it("exposes the panel as a labelled dialog", async () => {
    const { container } = await openAndSend("hi", "hello")
    const panel = await waitFor(() => {
      const p = container.querySelector('[role="dialog"]')
      if (!p) throw new Error("no dialog")
      return p as HTMLElement
    })
    expect(panel.getAttribute("aria-label")).toBe("RPC Concierge chat")
  })

  it("puts the transcript in a polite live region so a screen reader hears the reply", async () => {
    const { container } = await openAndSend("hi", "hello")
    const live = await waitFor(() => {
      const l = container.querySelector('[aria-live]')
      if (!l) throw new Error("no live region")
      return l as HTMLElement
    })
    // polite, not assertive: the answer streams token by token and assertive
    // would interrupt the reader on every chunk.
    expect(live.getAttribute("aria-live")).toBe("polite")
    await waitFor(() => expect(live.textContent).toContain("hello"))
  })

  it("closes on Escape and returns focus to the launcher", async () => {
    const { container, getByLabelText, getByPlaceholderText, getByText } = await openAndSend("hi", "hello")
    // Wait for the reply: the input is `disabled` while the request is in
    // flight, and a disabled input cannot take focus, so focusing earlier
    // silently no-ops and the Escape guard correctly ignores the keystroke.
    await waitFor(() => expect(getByText("hello")).toBeTruthy())
    const input = getByPlaceholderText(/Ask a question/) as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeNull())
    // ⚠ Assert the MECHANISM, not just the outcome. jsdom happily focuses a
    // display:none element, so the activeElement check below cannot by itself
    // catch a regression here — it passes even with the fix removed. The
    // launcher hides itself while an input is focused, and Escape is pressed
    // from the input, so closing MUST clear that flag or the restore lands on
    // an unfocusable element in a real browser.
    const launcher = getByLabelText("Open RPC concierge") as HTMLButtonElement
    expect(launcher.style.display).not.toBe("none")
    // Focus must come back to the launcher, or a keyboard user loses their
    // place in the page entirely. The launcher hides itself while an input is
    // focused, so this only passes because closing clears that flag first — a
    // hidden element cannot take focus.
    await waitFor(() => expect(document.activeElement).toBe(getByLabelText("Open RPC concierge")))
  })

  it("reflects open state on the launcher for assistive tech", async () => {
    const utils = render(<SupportChat />)
    const launcher = utils.getByLabelText("Open RPC concierge")
    expect(launcher.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(launcher)
    await waitFor(() => expect(utils.getByLabelText("Close RPC concierge").getAttribute("aria-expanded")).toBe("true"))
  })

  it("leaves Escape alone when focus is outside the panel", async () => {
    const { container } = await openAndSend("hi", "hello")
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy())
    // Focus parked on the body, i.e. some other surface owns the keystroke.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
  })
})

describe("SupportChat — quick-suggestion pills", () => {
  // The context route returns a GENERIC list on every open. Assigning it over
  // the page defaults made the 35-entry PAGE_DEFAULTS map dead code: a user on
  // /packs never saw "Best value pack right now?" because it was replaced ~200ms
  // after opening by the same four pills everyone else got.
  it("keeps the page-specific pills and appends the server's, rather than being overwritten", async () => {
    const serverPills = ["Report a bug", "Suggest a feature", "Something looks off", "How does X work?"]
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/api/support-chat/context"))
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: () => Promise.resolve({ pageSuggestions: serverPills }),
          } as unknown as Response)
        return streamRes("hi")
      })
    )
    const { getByText, queryByText } = render(<SupportChat pageContext="packs (nba-top-shot)" />)
    fireEvent.click(getByText("💬"))

    // ⚠ Both must hold AT THE SAME TIME. Asserting them in sequence is
    // vacuous: the page pill is set synchronously on open and the server pill
    // arrives ~a tick later, so a plain overwrite satisfies two sequential
    // waitFors — the first before the fetch lands, the second after. Waiting
    // for the server pill FIRST and then checking the page pill in the same
    // tick is what makes this catch a regression (mutation-verified).
    await waitFor(() => expect(getByText("Something looks off")).toBeTruthy())
    expect(getByText("Best value pack right now?")).toBeTruthy()
    // No duplicates: "Suggest a feature" is in both lists and must appear once.
    expect(queryByText("Suggest a feature")).toBeTruthy()
  })
})

describe("SupportChat — narrative-search discovery pill", () => {
  // Narrative search is the least guessable capability the concierge has, so it
  // gets a pill rather than a line of welcome copy: no reading cost, one tap,
  // and it demonstrates the feature by running it.
  it("offers the game-winner pill on a Top Shot page", async () => {
    vi.stubGlobal("fetch", routeFetch(() => streamRes("ok")))
    const { getByText } = render(<SupportChat pageContext="market (nba-top-shot)" />)
    fireEvent.click(getByText("💬"))
    await waitFor(() => expect(getByText("Find a game winner")).toBeTruthy())
  })

  // ⚠ The scoping rule, and the reason this test exists. Descriptive prose
  // covers part of Top Shot and 0% of every other collection, and the tool
  // scopes to the active collection — so this pill on an All Day page would
  // demonstrate a coverage gap rather than the feature. Copying it to the other
  // collections is only safe once their prose coverage is non-zero.
  it.each([
    ["market (nfl-all-day)"],
    ["sniper (laliga-golazos)"],
    ["overview (disney-pinnacle)"],
    ["overview (ufc)"],
  ])("does not offer it on %s, where prose coverage is 0%%", async (page) => {
    vi.stubGlobal("fetch", routeFetch(() => streamRes("ok")))
    const { getByText, queryByText } = render(<SupportChat pageContext={page} />)
    fireEvent.click(getByText("💬"))
    // Wait for the panel to have painted its pills before asserting absence,
    // else this passes simply because nothing has rendered yet.
    await waitFor(() => expect(queryByText("Report a bug") ?? queryByText("Bug on this page?")).toBeTruthy())
    expect(queryByText("Find a game winner")).toBeNull()
  })
})
