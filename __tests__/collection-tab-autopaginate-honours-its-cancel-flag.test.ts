import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// CI run 32536511776 failed the component job with ALL 2,989 tests passing:
//
//   ReferenceError: window is not defined
//     ❯ dispatchSetState react-dom-client.development.js
//     ❯ autoPaginate CollectionTabClient.tsx:828  → setLoadingMore(false)
//   This error originated in "__tests__/component-CollectionTabClient.test.tsx"
//
// Cause: `autoPaginate` is an effect-scoped async loop whose cleanup sets
// `cancelled = true`. Every write inside the loop checks it. The TRAILING
// `setLoadingMore(false)` after the loop did not — and the loop can only reach it
// up to ~300 ms AFTER teardown, because each iteration opens by awaiting a 300 ms
// timer and only observes the cancellation when that timer resolves.
//
// ⚠ THE RUNTIME SYMPTOM IS NOT REPRODUCIBLE FROM A TEST, and pretending otherwise
// would be the vacuous-assertion shape this repo keeps finding. React 19 makes a
// setState on an unmounted fiber a silent no-op, so in-process the write is
// invisible; the ReferenceError needs the jsdom ENVIRONMENT to be gone, which only
// happens after the whole file has finished. The browser-visible half — an effect
// re-run on wallet change, where the OLD run's `setLoadingMore(false)` lands after
// the NEW run's `setLoadingMore(true)` and clears the spinner while the new wallet
// is still paginating — is real but needs the search flow driven twice with the
// first mid-await, which no existing harness in that file supports.
//
// So this pins the STRUCTURAL property instead, scoped to the function body by
// brace matching rather than a whole-file grep. It is a source assertion for the
// same reason the edge-function guards are: the layer that would prove it at
// runtime is not reachable from here. If `autoPaginate` is renamed this reds
// loudly rather than passing vacuously — see the population arm below.

const SRC = path.resolve(
  __dirname,
  "../app/(collections)/[collection]/collection/CollectionTabClient.tsx",
)

/**
 * Strip comments before matching.
 *
 * ⚠ This is not defensive tidiness — the FIRST run of this guard reddened on its
 * own fix's explanatory comment, which quotes `setLoadingMore(false)` while
 * describing the bug. CLAUDE.md records this as a recurring shape (at least six
 * guards have fired on the comment documenting the fix); it took ninety seconds
 * to reproduce here. `[^:]` before `//` preserves `https://` in string literals.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * also blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

/** The text of `async function <name>()`'s body, by brace matching. */
function functionBody(src: string, name: string): string | null {
  const start = src.indexOf(`async function ${name}(`)
  if (start === -1) return null
  const open = src.indexOf("{", start)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

describe("the brace matcher is real (this guard cannot pass vacuously)", () => {
  it("extracts a body and rejects a name that is not there", () => {
    const sample = `async function a() { if (x) { y() } z() }\nasync function b() { q() }`
    expect(functionBody(sample, "a")).toBe(" if (x) { y() } z() ")
    expect(functionBody(sample, "b")).toBe(" q() ")
    expect(functionBody(sample, "nope")).toBeNull()
  })

  it("finds autoPaginate in the component (a rename must red this, not skip it)", () => {
    const body = functionBody(stripComments(readFileSync(SRC, "utf8")), "autoPaginate")
    expect(
      body,
      "autoPaginate not found — if it was renamed, retarget this guard rather than deleting it",
    ).not.toBeNull()
    // The body must actually be the loop, not some stub that happens to match.
    expect(body).toContain("setLoadingMore")
    expect(body).toContain("cancelled")
  })
})

describe("autoPaginate makes no state write after its effect was cancelled", () => {
  it("guards the trailing setLoadingMore(false)", () => {
    const body = functionBody(stripComments(readFileSync(SRC, "utf8")), "autoPaginate")!
    expect(
      /if\s*\(!cancelled\)\s*setLoadingMore\(false\)/.test(body),
      "the post-loop setLoadingMore(false) must be guarded by !cancelled — unguarded it " +
        "fires up to 300ms after teardown and throws inside React's dispatchSetState",
    ).toBe(true)
  })

  it("leaves no UNGUARDED setLoadingMore(false) statement behind", () => {
    // Adding the guarded call while leaving the original in place would pass the
    // arm above and change nothing. This is the arm that catches that.
    const body = functionBody(stripComments(readFileSync(SRC, "utf8")), "autoPaginate")!
    const unguarded = body
      .split("\n")
      .filter((l) => /setLoadingMore\(false\)/.test(l) && !/if\s*\(!cancelled\)/.test(l))
    expect(unguarded, `unguarded setLoadingMore(false): ${unguarded.join(" | ")}`).toHaveLength(0)
  })
})
