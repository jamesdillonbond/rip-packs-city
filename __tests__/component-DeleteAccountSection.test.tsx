// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import DeleteAccountSection from "@/components/profile/DeleteAccountSection"

// The delete-account control (platform review C1). What is pinned:
//   * nothing is sent until the user types the confirmation phrase;
//   * a refused / failed delete is STATED with the server's reason and the
//     success copy never appears;
//   * a successful delete clears every chain's owner-key slot.

const ok = vi.hoisted(() => ({ clearAllOwnerKeys: vi.fn() }))
vi.mock("@/lib/owner-key", () => ({ clearAllOwnerKeys: () => ok.clearAllOwnerKeys() }))

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

type FetchMock = ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>

function arm(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /delete my account/i }))
  return screen.getByLabelText(/type/i)
}

describe("DeleteAccountSection", () => {
  let fetchMock: FetchMock
  beforeEach(() => {
    ok.clearAllOwnerKeys.mockReset()
    fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      void _input
      void _init
      return jsonRes({ ok: true, rows: {} })
    })
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("sends nothing until the exact phrase is typed; the destructive button stays disabled", async () => {
    render(<DeleteAccountSection />)
    const input = arm()
    const go = screen.getByRole("button", { name: /permanently delete/i }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(input, { target: { value: "delete" } })
    expect(go.disabled, "lower-case is not the phrase").toBe(true)
    fireEvent.click(go)
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "DELETE" } })
    expect(go.disabled).toBe(false)
  })

  it("a refused delete states the server's reason and never shows the success copy", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: "auth_delete_failed", detail: "Your data was removed but the sign-in account could not be closed. Try again, or contact us." }, 502))
    render(<DeleteAccountSection />)
    fireEvent.change(arm(), { target: { value: "DELETE" } })
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("could not be closed")
    expect(screen.queryByText(/has been deleted/i)).toBeNull()
    expect(ok.clearAllOwnerKeys).not.toHaveBeenCalled()
    // The request that went out carried the phrase, as a DELETE.
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("/api/profile/account")
    expect(init?.method).toBe("DELETE")
    expect(JSON.parse(String(init?.body))).toEqual({ confirm: "DELETE" })
  })

  it("a network failure is stated as unreachable and the account described as unchanged", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    render(<DeleteAccountSection />)
    fireEvent.change(arm(), { target: { value: "DELETE" } })
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toMatch(/couldn.t reach/i)
    expect(alert.textContent).toMatch(/unchanged/i)
    expect(screen.queryByText(/has been deleted/i)).toBeNull()
  })

  it("a successful delete clears every owner-key slot and shows the done state", async () => {
    // jsdom refuses real navigation; the assertion is on the side effects, not the URL.
    render(<DeleteAccountSection />)
    fireEvent.change(arm(), { target: { value: "DELETE" } })
    fireEvent.click(screen.getByRole("button", { name: /permanently delete/i }))
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/has been deleted/i))
    expect(ok.clearAllOwnerKeys).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
