// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react"
import SupportChat from "@/components/SupportChat"

// The existing SupportChat suite covers the FAB + the NON-stream JSON path + the
// 429. This covers the STREAMING branch (the concierge's real answer path): the
// ReadableStream reader loop, the \x1e record separator that splits the streamed
// text from the trailing meta JSON, the meta application (dbId/escalated/
// momentCards), the connection-error catch, and the rpc-concierge-ask window
// event that opens + sends.

const trackMock = vi.fn()
vi.mock("@/lib/telemetry/track", () => ({ track: (...a: unknown[]) => trackMock(...a) }))

const ctxRes = () =>
  Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) } as unknown as Response)

// A streaming chat response: x-rpc-stream:1 header + a ReadableStream body. When
// `meta` is provided it's appended after a \x1e separator, as the server does.
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

async function openAndSend(msg: string) {
  const utils = render(<SupportChat />)
  fireEvent.click(utils.getByLabelText("Open RPC concierge"))
  const input = await waitFor(() => utils.getByPlaceholderText(/Ask a question/))
  fireEvent.change(input, { target: { value: msg } })
  fireEvent.click(utils.getByLabelText("Send"))
  return utils
}

describe("SupportChat streaming path", () => {
  it("renders streamed text and applies the trailing meta (escalation + moment card)", async () => {
    const meta = { messageId: "m1", escalated: true, momentCards: [{ playerName: "Victor Wembanyama", tier: "LEGENDARY" }] }
    vi.stubGlobal("fetch", routeFetch(() => streamRes("Here is a streamed answer", meta)))
    const { getByText } = await openAndSend("stream please")
    await waitFor(() => expect(getByText("Here is a streamed answer")).toBeTruthy())
    // meta applied after the separator: escalation banner + moment card.
    await waitFor(() => expect(getByText(/Flagged for the team/)).toBeTruthy())
    expect(getByText("Victor Wembanyama")).toBeTruthy()
  })

  it("shows a connection-issue message when the request throws", async () => {
    vi.stubGlobal("fetch", routeFetch(() => Promise.reject(new Error("network down"))))
    const { getByText } = await openAndSend("boom")
    await waitFor(() => expect(getByText(/Connection issue/)).toBeTruthy())
  })

  it("opens and answers on the rpc-concierge-ask window event", async () => {
    vi.stubGlobal("fetch", routeFetch(() => streamRes("Answer via event")))
    render(<SupportChat />)
    window.dispatchEvent(new CustomEvent("rpc-concierge-ask", { detail: { text: "hi from event" } }))
    // ⚠ 4000, raised from 2000 on 2026-09-05 — this test is the suite's most
    // frequent flake and it fails ONLY under full-suite concurrency.
    //
    // MEASURED: green in isolation (2 for 2) and red in 2 of 3 full runs, at a
    // duration (~2,180 ms) that matches the old budget being spent rather than a
    // hang. On the red runs the PANEL IS RENDERED — the failure dump shows the
    // "RPC Concierge chat" dialog — so the window event WAS received and
    // `setIsOpen(true)` ran; only the streamed answer had not arrived yet.
    //
    // ⛔ THE ROOT CAUSE IS NOT ESTABLISHED, and this comment does not claim one.
    // Two hypotheses were tested and DROPPED: (a) a missed listener — refuted,
    // the panel opens; (b) leaked fake timers stopping the handler's real 80 ms
    // `setTimeout` — refuted, every `__tests__` file that calls `useFakeTimers`
    // also calls `useRealTimers`. What is left is that this path costs an extra
    // 80 ms timer plus a re-render before the fetch even starts, on top of the
    // stream, and 2 s is simply too tight for it under parallel load.
    //
    // ⚠ This RAISES A BUDGET; it does not weaken the assertion. The answer must
    // still render or this fails. 4000 matches budgets already used elsewhere in
    // `__tests__` and sits far under the 30 s `testTimeout` in vitest.config.ts.
    // If it flakes again, the budget is NOT the cause — look at the stale
    // `sendMessage` the 80 ms timer closes over in components/SupportChat.tsx.
    await waitFor(() => expect(document.body.textContent).toContain("Answer via event"), { timeout: 4000 })
  })
})
