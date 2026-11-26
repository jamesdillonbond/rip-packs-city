// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import InteractiveSlab from "@/components/InteractiveSlab"

// CONTRACT (2026-11-25): the slab is opt-in. Off (the server render, and any
// browser that never opted in) it is the same tier-bordered square the hero was
// — the media and nothing else, no back face, no controls. On (?slab=1) the back
// face and the Flip control exist, and the back carries only what was passed.

function slab() {
  return (
    <InteractiveSlab
      frameColor="var(--rpc-tier-rare)"
      title="Luka Doncic"
      eyebrow="NBA Top Shot"
      subtitle="RARE · Series 7"
      serialLine="#1 / 99"
      finish="first"
      rows={[{ label: "Set", value: "Metallic Gold LE" }, { label: "FMV", value: "$120.00" }]}
    >
      <span aria-label="media" role="img">m</span>
    </InteractiveSlab>
  )
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.history.replaceState(null, "", "/")
})

describe("InteractiveSlab", () => {
  it("server-renders the plain hero: media, no back face, no controls", () => {
    const html = renderToStaticMarkup(slab())
    expect(html).toContain('aria-label="media"')
    expect(html).not.toContain("RIP PACKS CITY")
    expect(html).not.toContain("Flip")
    expect(html).not.toContain("#1 / 99")
  })

  it("stays plain in a browser that never opted in", () => {
    const { queryByText, getByRole } = render(slab())
    expect(getByRole("img")).toBeTruthy()
    expect(queryByText("Flip")).toBeNull()
    expect(queryByText("#1 / 99")).toBeNull()
  })

  it("opts in with ?slab=1, remembers it, and shows the back and the Flip control", () => {
    window.history.replaceState(null, "", "/moment/x?slab=1")
    const { getByText, getByRole } = render(slab())
    expect(getByText("Flip")).toBeTruthy()
    expect(getByText("#1 / 99")).toBeTruthy()
    expect(getByText("#1 Serial")).toBeTruthy()
    expect(getByText("Metallic Gold LE")).toBeTruthy()
    expect(getByRole("group").getAttribute("tabindex")).toBe("0")
    expect(window.localStorage.getItem("rpc:slab3d")).toBe("1")
  })

  it("?slab=0 turns a remembered opt-in off", () => {
    window.localStorage.setItem("rpc:slab3d", "1")
    window.history.replaceState(null, "", "/moment/x?slab=0")
    const { queryByText } = render(slab())
    expect(queryByText("Flip")).toBeNull()
    expect(window.localStorage.getItem("rpc:slab3d")).toBe("0")
  })

  it("does not invent a finish chip for an ordinary serial", () => {
    window.history.replaceState(null, "", "/moment/x?slab=1")
    const { queryByText } = render(
      <InteractiveSlab frameColor="red" title="T" rows={[]} finish={null}>
        <span>m</span>
      </InteractiveSlab>,
    )
    expect(queryByText(/Serial$/)).toBeNull()
    fireEvent.click(queryByText("Flip")!)
  })
})

// ── interaction: drag, fling, flip, keys, tilt ───────────────────────────────
import { vi, beforeEach } from "vitest"
import { act } from "@testing-library/react"

function mockMedia(matches: Record<string, boolean>) {
  window.matchMedia = ((q: string) => ({
    matches: !!matches[q],
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

function card(group: HTMLElement): HTMLElement {
  return group.firstElementChild as HTMLElement
}
function rotY(el: HTMLElement): number {
  const m = /rotateY\((-?[\d.]+)deg\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}
function run(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe("InteractiveSlab interaction", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "Date"] })
    window.history.replaceState(null, "", "/moment/x?slab=1")
    mockMedia({})
  })
  afterEach(() => {
    vi.useRealTimers()
    // @ts-expect-error test cleanup of a jsdom gap we filled
    delete window.matchMedia
    // @ts-expect-error test cleanup
    delete window.DeviceOrientationEvent
  })

  it("spins under a drag and settles face-on when released slowly", () => {
    const { getByRole } = render(slab())
    const group = getByRole("group")
    fireEvent.pointerDown(group, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(group, { pointerId: 1, pointerType: "mouse", clientX: 160, clientY: 90 })
    expect(Math.abs(rotY(card(group)))).toBeGreaterThan(10)
    run(200) // the finger rests: no fling
    fireEvent.pointerUp(group, { pointerId: 1, pointerType: "mouse" })
    run(4000)
    expect(rotY(card(group)) % 180).toBe(0)
  })

  it("coasts after a fling, then still lands on a face", () => {
    const { getByRole } = render(slab())
    const group = getByRole("group")
    fireEvent.pointerDown(group, { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 0 })
    for (let i = 1; i <= 5; i++) {
      run(16)
      fireEvent.pointerMove(group, { pointerId: 2, pointerType: "touch", clientX: i * 40, clientY: 0 })
    }
    fireEvent.pointerUp(group, { pointerId: 2, pointerType: "touch" })
    run(8000)
    expect(rotY(card(group)) % 180).toBe(0)
  })

  it("flips to the back with the button, Enter, and the arrow keys", () => {
    const { getByRole, getByText } = render(slab())
    const group = getByRole("group")
    fireEvent.click(getByText("Flip"))
    run(3000)
    expect(getByText("Show front")).toBeTruthy()
    expect(group.getAttribute("aria-label")).toContain("Showing the back")
    fireEvent.keyDown(group, { key: "Enter" })
    run(3000)
    expect(getByText("Flip")).toBeTruthy()
    fireEvent.keyDown(group, { key: "ArrowRight" })
    run(3000)
    expect(getByText("Show front")).toBeTruthy()
    fireEvent.keyDown(group, { key: "ArrowLeft" })
    run(3000)
    expect(getByText("Flip")).toBeTruthy()
    expect(rotY(card(group)) % 360).toBe(0)
  })

  it("leans toward a hovering mouse and straightens when it leaves", () => {
    const { getByRole } = render(slab())
    const group = getByRole("group")
    fireEvent.pointerMove(group, { pointerType: "mouse", clientX: 5, clientY: 5 })
    run(500)
    fireEvent.pointerLeave(group, { pointerType: "mouse" })
    run(3000)
    expect(rotY(card(group))).toBe(0)
  })

  it("under reduced motion a flip lands at once", () => {
    mockMedia({ "(prefers-reduced-motion: reduce)": true })
    const { getByRole, getByText } = render(slab())
    fireEvent.click(getByText("Flip"))
    expect(rotY(card(getByRole("group")))).toBe(180)
    fireEvent.keyDown(getByRole("group"), { key: "ArrowLeft" })
    expect(rotY(card(getByRole("group")))).toBe(0)
  })

  it("offers phone tilt only on a coarse pointer, and asks permission where the browser requires it", async () => {
    mockMedia({ "(pointer: coarse)": true })
    let asked = 0
    const ctor = function () {} as unknown as { requestPermission: () => Promise<string> }
    ctor.requestPermission = () => {
      asked++
      return Promise.resolve("granted")
    }
    ;(window as unknown as { DeviceOrientationEvent: unknown }).DeviceOrientationEvent = ctor
    const { getByText, getByRole } = render(slab())
    run(50)
    const tilt = getByText("Tilt")
    await act(async () => {
      fireEvent.click(tilt)
    })
    expect(asked).toBe(1)
    expect(getByText("Tilt on")).toBeTruthy()
    act(() => {
      const ev = new Event("deviceorientation") as Event & { beta: number; gamma: number }
      Object.assign(ev, { beta: 40, gamma: 0 })
      window.dispatchEvent(ev)
      const ev2 = new Event("deviceorientation") as Event & { beta: number; gamma: number }
      Object.assign(ev2, { beta: 50, gamma: 20 })
      window.dispatchEvent(ev2)
    })
    run(1000)
    expect(rotY(card(getByRole("group")))).not.toBe(0)
    await act(async () => {
      fireEvent.click(getByText("Tilt on"))
    })
    run(3000)
    expect(getByText("Tilt")).toBeTruthy()
  })

  it("says so when tilt permission is refused", async () => {
    mockMedia({ "(pointer: coarse)": true })
    const ctor = function () {} as unknown as { requestPermission: () => Promise<string> }
    ctor.requestPermission = () => Promise.reject(new Error("no"))
    ;(window as unknown as { DeviceOrientationEvent: unknown }).DeviceOrientationEvent = ctor
    const { getByText } = render(slab())
    run(50)
    await act(async () => {
      fireEvent.click(getByText("Tilt"))
    })
    expect(getByText("Tilt blocked")).toBeTruthy()
  })
})

describe("InteractiveSlab timing", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("settles in the same wall-clock time whatever the display's frame rate", () => {
    // Drive requestAnimationFrame by hand at a chosen frame interval and count
    // how many milliseconds a flip takes to land.
    function msToSettle(frameMs: number): number {
      window.history.replaceState(null, "", "/moment/x?slab=1")
      mockMedia({})
      let queue: Array<(t: number) => void> = []
      vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
        queue.push(cb)
        return queue.length
      })
      vi.stubGlobal("cancelAnimationFrame", () => {})
      const { getByText, getByRole, unmount } = render(slab())
      fireEvent.click(getByText("Flip"))
      const c = card(getByRole("group"))
      let t = 0
      while (t < 10_000) {
        const q = queue
        queue = []
        if (q.length === 0) break
        t += frameMs
        act(() => q.forEach((cb) => cb(t)))
      }
      const landed = rotY(c)
      unmount()
      cleanup()
      expect(landed).toBe(180)
      return t
    }
    const at60 = msToSettle(1000 / 60)
    const at120 = msToSettle(1000 / 120)
    const at30 = msToSettle(1000 / 30)
    expect(Math.abs(at120 - at60)).toBeLessThan(at60 * 0.15)
    expect(Math.abs(at30 - at60)).toBeLessThan(at60 * 0.15)
  })
})

describe("InteractiveSlab stats on the back", () => {
  it("shows the game line and the season when given, and the serial beside the name", () => {
    window.history.replaceState(null, "", "/moment/x?slab=1")
    const { getByText, getByLabelText } = render(
      <InteractiveSlab
        frameColor="red"
        title="Damian Lillard"
        serialLine="#53 / 75"
        rows={[{ label: "Set", value: "NBA Cup" }]}
        finish={null}
        stats={{
          game: { title: "This game", detail: "vs ORL · W 114-109 · Dec 10, 2024", chips: [{ label: "PTS", value: "28" }, { label: "AST", value: "9" }] },
          season: { title: "2024-25 season", detail: "Milwaukee Bucks · 58 games", chips: [{ label: "PPG", value: "24.9" }] },
        }}
      >
        <span>m</span>
      </InteractiveSlab>,
    )
    expect(getByLabelText("This game").textContent).toContain("28")
    expect(getByText("vs ORL · W 114-109 · Dec 10, 2024")).toBeTruthy()
    expect(getByLabelText("2024-25 season").textContent).toContain("PPG")
    expect(getByText("#53 / 75")).toBeTruthy()
  })
})

describe("InteractiveSlab badges on the back", () => {
  it("shows up to three badges, de-duplicated, then a +N for the rest", () => {
    window.history.replaceState(null, "", "/moment/x?slab=1")
    const { getByLabelText } = render(
      <InteractiveSlab frameColor="red" title="T" rows={[]} finish={null} badges={["Rookie Year", "Rookie Year", "Top Shot Debut", "Rookie Mint", " ", "Championship Year"]}>
        <span>m</span>
      </InteractiveSlab>,
    )
    const list = getByLabelText("Badges")
    const items = Array.from(list.querySelectorAll("li")).map((li) => li.textContent)
    expect(items).toEqual(["Rookie Year", "Top Shot Debut", "Rookie Mint", "+1"])
  })
  it("renders no badge row for none", () => {
    window.history.replaceState(null, "", "/moment/x?slab=1")
    const { queryByLabelText } = render(
      <InteractiveSlab frameColor="red" title="T" rows={[]} finish={null} badges={[]}>
        <span>m</span>
      </InteractiveSlab>,
    )
    expect(queryByLabelText("Badges")).toBeNull()
  })
})

describe("InteractiveSlab box score link", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "Date"] })
    window.history.replaceState(null, "", "/moment/x?slab=1")
  })
  afterEach(() => vi.useRealTimers())
  it("offers ESPN's box score only while the back is showing", () => {
    const { getByText, queryByText } = render(
      <InteractiveSlab
        frameColor="red"
        title="T"
        rows={[]}
        finish={null}
        stats={{ game: { title: "This game", detail: null, chips: [{ label: "PTS", value: "28", aboveAverage: true }], link: "https://www.espn.com/nba/game/_/gameId/401734902" }, season: null }}
      >
        <span>m</span>
      </InteractiveSlab>,
    )
    expect(queryByText("ESPN box score ↗")).toBeNull()
    fireEvent.click(getByText("Flip"))
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    const a = getByText("ESPN box score ↗") as HTMLAnchorElement
    expect(a.getAttribute("href")).toBe("https://www.espn.com/nba/game/_/gameId/401734902")
    expect(a.getAttribute("rel")).toContain("noopener")
    expect(getByText("(above season average)", { exact: false })).toBeTruthy()
  })
})
