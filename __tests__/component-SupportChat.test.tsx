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
})
