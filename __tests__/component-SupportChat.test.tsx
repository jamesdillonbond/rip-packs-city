// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SupportChat from "@/components/SupportChat"

// Drives the AI concierge widget: the FAB open/close, the message send flow
// (track beacon → POST /api/support-chat → render the assistant reply on the
// non-stream JSON path), and the 429 rate-limit break message. The streaming
// branch (ReadableStream) is out of scope; the non-stream JSON path is the one a
// no-x-rpc-stream response takes.

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

let fetchMock: ReturnType<typeof vi.fn>

// A chat response with NO x-rpc-stream header → the component takes the JSON path.
const chatRes = (body: unknown, status = 200) =>
  Promise.resolve({
    status,
    headers: { get: () => null },
    body: null,
    json: () => Promise.resolve(body),
  } as unknown as Response)
const ctxRes = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) } as unknown as Response)

function routeFetch(chat: (body: any) => Promise<Response>) {
  return vi.fn((url: string, init?: any) => {
    if (url.includes("/api/support-chat/context")) return ctxRes()
    if (url.includes("/api/support-chat/feedback")) return chatRes({ ok: true })
    // the chat endpoint
    return chat(init?.body ? JSON.parse(init.body) : {})
  })
}

// Like routeFetch but with a controllable /context body (drives the welcome
// rewrite + page-suggestion branches).
function routeFetchCtx(chat: (body: any) => Promise<Response>, ctxBody: unknown) {
  return vi.fn((url: string, init?: any) => {
    if (url.includes("/api/support-chat/context"))
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(ctxBody) } as unknown as Response)
    if (url.includes("/api/support-chat/feedback")) return chatRes({ ok: true })
    return chat(init?.body ? JSON.parse(init.body) : {})
  })
}

beforeEach(() => {
  trackMock.mockClear()
  sessionStorage.clear()
  // jsdom doesn't implement scrollIntoView (the messages-end auto-scroll effect).
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("SupportChat", () => {
  it("starts closed and opens the panel on the FAB", async () => {
    fetchMock = routeFetch(() => chatRes({ response: "hi" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, queryByLabelText } = render(<SupportChat />)
    // closed: FAB present, no input
    expect(getByLabelText("Open RPC concierge")).toBeTruthy()
    expect(queryByLabelText("Send")).toBeNull()

    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(getByLabelText("Send")).toBeTruthy())
  })

  it("sends a message: fires the track beacon, POSTs, and renders the reply", async () => {
    let postedBody: any = null
    fetchMock = routeFetch((body) => {
      postedBody = body
      return chatRes({ response: "Here are two deals for you", escalated: false })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByPlaceholderText, getByText } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))

    const input = await waitFor(() => getByPlaceholderText(/Ask a question/))
    fireEvent.change(input, { target: { value: "any deals?" } })
    fireEvent.click(getByLabelText("Send"))

    await waitFor(() => expect(getByText("Here are two deals for you")).toBeTruthy())
    expect(trackMock).toHaveBeenCalledWith("chat-message-sent", { length: "any deals?".length })
    // the POST carried the message + a session id + stream flag
    expect(postedBody.message).toBe("any deals?")
    expect(typeof postedBody.sessionId).toBe("string")
    expect(postedBody.stream).toBe(true)
  })

  it("shows the rate-limit break message on a 429", async () => {
    fetchMock = routeFetch(() => chatRes({}, 429))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByPlaceholderText, getByText } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    const input = await waitFor(() => getByPlaceholderText(/Ask a question/))
    fireEvent.change(input, { target: { value: "spam" } })
    fireEvent.click(getByLabelText("Send"))
    await waitFor(() => expect(getByText(/I need a short break/)).toBeTruthy())
  })

  it("does not send an empty message (Send stays disabled)", async () => {
    fetchMock = routeFetch(() => chatRes({ response: "x" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    const send = await waitFor(() => getByLabelText("Send") as HTMLButtonElement)
    expect(send.disabled).toBe(true)
    fireEvent.click(send)
    // only the context fetch happened — never the chat endpoint
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).endsWith("/api/support-chat"))).toBe(true)
    expect(trackMock).not.toHaveBeenCalledWith("chat-message-sent", expect.anything())
  })

  // ── deepening: greeting variants, suggestion pills, Enter key, close ──────────
  it("greets a known ownerKey, renders page-default suggestion pills, and sends one on click", async () => {
    let posted: any = null
    fetchMock = routeFetch((body) => { posted = body; return chatRes({ response: "ok" }) })
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByText, container } = render(
      <SupportChat pageContext="overview (nba-top-shot)" ownerKey="damian" />,
    )
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(container.textContent).toContain("Hey damian")) // owner welcome variant
    // PAGE_DEFAULTS for "overview (nba-top-shot)" pills render
    const pill = await waitFor(() => getByText("Top sales today"))
    fireEvent.click(pill)
    await waitFor(() => expect(posted?.message).toBe("Top sales today"))
  })

  it("renders the signed-in header label", async () => {
    fetchMock = routeFetch(() => chatRes({ response: "x" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, container } = render(<SupportChat signedInLabel="dapper.eth" />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    await waitFor(() => expect(container.textContent).toContain("Signed in as dapper.eth"))
  })

  it("sends on Enter and closes via the ✕ button", async () => {
    fetchMock = routeFetch(() => chatRes({ response: "answered" }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByPlaceholderText, getByText, queryByLabelText } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    const input = await waitFor(() => getByPlaceholderText(/Ask a question/))
    fireEvent.change(input, { target: { value: "hi there" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false })
    await waitFor(() => expect(getByText("answered")).toBeTruthy())
    // close via the header ✕
    fireEvent.click(getByLabelText("Close"))
    await waitFor(() => expect(queryByLabelText("Send")).toBeNull())
  })

  // ── context-driven welcome rewrites ─────────────────────────────────────────
  const openWith = async (ctx: unknown, props: Record<string, unknown> = {}) => {
    fetchMock = routeFetchCtx(() => chatRes({ response: "x" }), ctx)
    vi.stubGlobal("fetch", fetchMock)
    const utils = render(<SupportChat ownerKey="dana" {...props} />)
    fireEvent.click(utils.getByLabelText("Open RPC concierge"))
    return utils
  }

  it("rewrites the welcome for a returning beta tester whose feedback shipped", async () => {
    const { container } = await openWith({ returningBetaTester: true, lastOpenFeedback: { feedback_summary: "search bug", feedback_status: "shipped" } })
    await waitFor(() => expect(container.textContent).toContain("shipped — thanks for the catch"))
    expect(container.textContent).toContain("Welcome back, dana.")
  })

  it("rewrites the welcome for in-progress / triaged / queued feedback statuses", async () => {
    const inProg = await openWith({ returningBetaTester: true, lastOpenFeedback: { feedback_summary: "slow page", feedback_status: "in_progress" } })
    await waitFor(() => expect(inProg.container.textContent).toContain("is in progress"))
    cleanup()
    const wont = await openWith({ returningBetaTester: true, lastOpenFeedback: { feedback_summary: "nit", feedback_status: "wontfix" } })
    await waitFor(() => expect(wont.container.textContent).toContain("triaged as wontfix"))
    cleanup()
    const queued = await openWith({ returningBetaTester: true, lastOpenFeedback: { feedback_summary: "idea", feedback_status: "new" } })
    await waitFor(() => expect(queued.container.textContent).toContain("still in the queue"))
  })

  it("falls back to a prior-session count, and to last-topics for a returning user", async () => {
    const counted = await openWith({ returningBetaTester: true, conversationCount: 3 })
    await waitFor(() => expect(counted.container.textContent).toContain("3 prior sessions on file"))
    cleanup()
    const topics = await openWith({ returningUser: true, lastTopics: ["FMV", "pack EV"] })
    await waitFor(() => expect(topics.container.textContent).toContain("Last time we touched on FMV, pack EV"))
  })

  it("applies server-provided page suggestions over the static defaults", async () => {
    const { getByText } = await openWith({ pageSuggestions: ["Custom pill A", "Custom pill B"] })
    await waitFor(() => expect(getByText("Custom pill A")).toBeTruthy())
  })

  // ── MomentCardUI + FeedbackButtons (rendered off a non-stream reply) ─────────
  it("renders moment cards from a reply and posts thumbs feedback", async () => {
    const momentCards = [
      { playerName: "LeBron James", setName: "Base Set", series: "S4", price: 42.5, fmv: 60, discountPct: 29, tier: "legendary", source: "flowty", serialNumber: 7, mintCount: 100, thumbnailUrl: "https://x/l.png", buyUrl: "https://buy/1", badgeNames: ["rookie_mint"] },
      { playerName: "Steph Curry", price: 10, fmv: 12, tier: "rare", source: "topshot" }, // no thumbnail → 🏀, FMV-only (no discount)
    ]
    let feedbackBody: any = null
    fetchMock = vi.fn((url: string, init?: any) => {
      if (url.includes("/api/support-chat/context")) return ctxRes()
      if (url.includes("/api/support-chat/feedback")) { feedbackBody = init?.body ? JSON.parse(init.body) : null; return chatRes({ ok: true }) }
      return chatRes({ response: "Here are two", escalated: false, messageId: 55, momentCards })
    })
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByPlaceholderText, getByText, container } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    const input = await waitFor(() => getByPlaceholderText(/Ask a question/))
    fireEvent.change(input, { target: { value: "deals" } })
    fireEvent.click(getByLabelText("Send"))

    await waitFor(() => expect(getByText("LeBron James")).toBeTruthy())
    const t = container.textContent ?? ""
    expect(t).toContain("$42.50") // price.toFixed(2)
    expect(t).toContain("29% below FMV") // discount branch
    expect(t).toContain("Steph Curry")
    expect(t).toContain("FMV $12.00") // fmv-only branch (no discount)
    expect(t).toContain("Flowty") // source label
    expect(t).toContain("#7/100") // serial + mint
    expect(getByText("Buy →")).toBeTruthy()

    // FeedbackButtons render for the non-escalated assistant message
    fireEvent.click(getByLabelText("Helpful"))
    await waitFor(() => expect(feedbackBody?.feedback).toBe("up"))
    expect(feedbackBody?.messageId).toBe(55) // dbId from the reply
    // a second click is a no-op (sent latch)
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/feedback")).length
    fireEvent.click(getByLabelText("Not helpful"))
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/feedback")).length).toBe(before)
  })

  it("coerces escalate=true (concierge unavailable) into the Flagged banner and hides feedback", async () => {
    fetchMock = routeFetch(() => chatRes({ response: "Sorry, escalating", escalated: false, escalate: true }))
    vi.stubGlobal("fetch", fetchMock)
    const { getByLabelText, getByPlaceholderText, getByText, queryByLabelText } = render(<SupportChat />)
    fireEvent.click(getByLabelText("Open RPC concierge"))
    const input = await waitFor(() => getByPlaceholderText(/Ask a question/))
    fireEvent.change(input, { target: { value: "help" } })
    fireEvent.click(getByLabelText("Send"))
    await waitFor(() => expect(getByText(/Flagged for the team/)).toBeTruthy())
    // escalated message suppresses the thumbs buttons
    expect(queryByLabelText("Helpful")).toBeNull()
  })
})
