// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, act, cleanup } from "@testing-library/react"
import fs from "node:fs"
import path from "node:path"
import { useIpfsRetry } from "@/lib/media/use-ipfs-retry"

// The shared retry behind every ipfs-media <img>. Pinned here rather than only through IpfsThumb,
// because /insights/trophies uses the hook with its OWN fallback markup — a surface where the bug
// wore a different costume: it already HAD an onError, and gave up on the first error, so the
// first visitor to each CID got the grey fallback where one retry shows the real trophy art.
function Probe({ src }: { src: string }) {
  const { key, onError, failed } = useIpfsRetry()
  if (failed) return <div data-testid="fallback" />
  // eslint-disable-next-line @next/next/no-img-element
  return <img key={key} data-testid="img" src={src} alt="t" onError={onError} />
}

describe("useIpfsRetry — one retry on the cold-cache 502, then give up", () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })
  const SRC = "/api/public/ipfs-media/bafybeifh2efyqclrrbfxragdyb3xnferweakthnjcts62c3fh6gs4q4xyy"

  it("re-requests the SAME url after one failure — never a cache-busted one", async () => {
    vi.useFakeTimers()
    render(<Probe src={SRC} />)
    await act(async () => { screen.getByTestId("img").dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(1500) })
    const img = screen.getByTestId("img")
    expect(img.getAttribute("src")).toBe(SRC)
    expect(img.getAttribute("src")).not.toContain("?")
  })

  it("does not give up on the first error — that is the whole defect", async () => {
    vi.useFakeTimers()
    render(<Probe src={SRC} />)
    await act(async () => { screen.getByTestId("img").dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(screen.queryByTestId("fallback")).toBeNull()
    expect(screen.getByTestId("img")).toBeTruthy()
  })

  it("gives up after the second failure rather than retrying forever", async () => {
    vi.useFakeTimers()
    render(<Probe src={SRC} />)
    await act(async () => { screen.getByTestId("img").dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(1500) })
    await act(async () => { screen.getByTestId("img").dispatchEvent(new Event("error")) })
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(screen.queryByTestId("img")).toBeNull()
    expect(screen.getByTestId("fallback")).toBeTruthy()
  })

  it("an image that never errors is left completely alone", () => {
    render(<Probe src={SRC} />)
    expect(screen.getByTestId("img").getAttribute("key")).toBeNull() // key is React-internal, not a DOM attr
    expect(screen.queryByTestId("fallback")).toBeNull()
  })

  // Ratchet. The give-up-on-first-error spelling is what produced the defect, and it is one line
  // away from coming back on any surface that renders ipfs-media art. The two surfaces where the
  // cold-cache 502 was actually MEASURED must go through the hook.
  it("the measured ipfs surfaces retry through the hook, not a one-shot onError", () => {
    const files = [
      "components/entity/IpfsThumb.tsx",
      "app/insights/trophies/TrophiesBoardClient.tsx",
    ]
    for (const f of files) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8")
      expect(src, `${f} must use the shared retry`).toContain("useIpfsRetry")
      // an onError that only ever flips a boolean false is the give-up-first shape
      expect(src, `${f} still gives up on the first error`).not.toMatch(
        /onError=\{\(\)\s*=>\s*set\w+\(false\)\}/,
      )
    }
  })
})
