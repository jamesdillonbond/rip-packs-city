import { vi } from "vitest"
import type { ReactElement, ReactNode } from "react"

// Capture harness for the /api/og/** social cards.
//
// WHY IT EXISTS. __tests__/api-og-cards-render-sweep.test.ts is the breadth floor
// for these routes: it drives all 44 and asserts real PNG magic + IHDR dimensions,
// which is what catches the known 0-byte-body regression. Its own header says what
// it deliberately does NOT do — "Not the headline text or the data branch.
// Upstreams are stubbed generically, so most cards render their FALLBACK copy" —
// and points at per-card tests for the rest.
//
// That leaves the data path untested, and it is the half a status code cannot see:
// the sweep proves a card renders SOMETHING, never that it renders the RIGHT thing.
// Measured before this landed, the three worst-covered files in the entire primary
// coverage gate were OG cards — og/moment 21.4% branch, og/edition 25.5%, og/pack
// 36.0% — and the uncovered branches are exactly the ones that decide what number
// goes on a share card.
//
// HOW. Rendering to a PNG and asserting on pixels is not viable, so this stubs
// `next/og`'s ImageResponse and keeps the React element it was handed. The tree
// carries the text and the colours, so a test can assert "this UFC moment does NOT
// print a Current FMV" — a documented honesty constraint (closed markets carry a
// frozen value forward; presenting it as current on an unfurl is an overclaim)
// that no byte-level assertion could ever express.
//
// ⚠ Use this ALONGSIDE the sweep, never instead of it. The stub means these tests
// cannot see a satori-level render failure; the sweep, which renders for real, is
// what covers that. Two harnesses because the two failure modes are different.

export interface OgCapture {
  /** The element passed to the most recent `new ImageResponse(...)`. */
  element(): ReactElement
  /** The options object (width/height) from that same call. */
  options(): Record<string, unknown> | undefined
  /** Number of ImageResponse constructions so far. */
  count(): number
  reset(): void
}

const state: { calls: Array<{ el: ReactElement; opts?: Record<string, unknown> }> } = { calls: [] }

/**
 * Install the `next/og` stub. Call at module scope (vi.mock is hoisted) or via
 * `vi.doMock` before a dynamic import of the route.
 */
export function installOgCapture(): OgCapture {
  vi.doMock("next/og", () => ({
    ImageResponse: class {
      status = 200
      headers = new Headers({ "content-type": "image/png" })
      constructor(el: ReactElement, opts?: Record<string, unknown>) {
        state.calls.push({ el, opts })
      }
      async arrayBuffer() {
        return new ArrayBuffer(0)
      }
    },
  }))
  return {
    element: () => {
      const last = state.calls[state.calls.length - 1]
      if (!last) throw new Error("no ImageResponse was constructed")
      return last.el
    },
    options: () => state.calls[state.calls.length - 1]?.opts,
    count: () => state.calls.length,
    reset: () => {
      state.calls = []
    },
  }
}

/** Reset captured calls between tests. */
export function resetOgCapture(): void {
  state.calls = []
}

interface ElementLike {
  type?: unknown
  props?: { children?: ReactNode; style?: Record<string, unknown>; [k: string]: unknown }
}

function isElement(n: unknown): n is ElementLike {
  return typeof n === "object" && n !== null && "props" in (n as Record<string, unknown>)
}

/**
 * Depth-first walk yielding every node in the tree, function components included
 * (they are INVOKED with their props so their output is walked too — several
 * cards render a `<DefaultCard />`, and without this the fallback branch would
 * look empty).
 */
function* walk(node: ReactNode, depth = 0): Generator<ElementLike> {
  if (depth > 200) return // cycle guard; real card trees are ~10 deep
  if (node == null || typeof node === "boolean") return
  if (Array.isArray(node)) {
    for (const c of node) yield* walk(c, depth + 1)
    return
  }
  if (!isElement(node)) return
  yield node
  if (typeof node.type === "function") {
    try {
      const out = (node.type as (p: unknown) => ReactNode)(node.props ?? {})
      yield* walk(out, depth + 1)
    } catch {
      // A component that needs a runtime the stub does not provide still
      // contributes its own props below; do not fail the walk over it.
    }
  }
  yield* walk(node.props?.children, depth + 1)
}

/**
 * All text in the rendered card, joined with spaces.
 *
 * ⚠ Numbers and strings are BOTH collected. A card that prints `{fmvText}` where
 * fmvText is "" contributes nothing, which is the point: asserting
 * `not.toContain("Current FMV")` then genuinely proves the label was suppressed.
 */
export function ogText(el: ReactElement): string {
  const parts: string[] = []
  for (const node of walk(el)) {
    const ch = node.props?.children
    const collect = (c: ReactNode) => {
      if (typeof c === "string" || typeof c === "number") parts.push(String(c))
    }
    if (Array.isArray(ch)) ch.forEach(collect)
    else collect(ch)
  }
  return parts.join(" ")
}

/** Every `style` object in the tree — for asserting tier accent colours. */
export function ogStyles(el: ReactElement): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const node of walk(el)) {
    if (node.props?.style) out.push(node.props.style)
  }
  return out
}

/** True when any node in the tree carries `color` or `border` using `hex`. */
export function usesColor(el: ReactElement, hex: string): boolean {
  const needle = hex.toLowerCase()
  return ogStyles(el).some((s) =>
    Object.values(s).some((v) => typeof v === "string" && v.toLowerCase().includes(needle)),
  )
}

/** The `src` of every `<img>` in the tree. */
export function ogImageSrcs(el: ReactElement): string[] {
  const out: string[] = []
  for (const node of walk(el)) {
    if (node.type === "img" && typeof node.props?.src === "string") out.push(node.props.src)
  }
  return out
}
