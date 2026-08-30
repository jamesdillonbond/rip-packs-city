import { describe, it, expect, vi } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { ogFetch, OG_FETCH_TIMEOUT_MS } from "@/lib/og/og-fetch"

/**
 * NO OG CARD MAY WAIT FOREVER FOR A READ.
 *
 * A card renders while a social crawler holds the connection. Measured
 * 2026-08-29: **30 bare `fetch()` calls across 28 files** under `app/api/og/**`
 * and `lib/og/**`, and **zero** of them carried an `AbortSignal` — against
 * CLAUDE.md's standing "Bound every `fetch` — no default timeout". The sibling
 * incident is on record: the unbounded brand-font fetch stalled a card that
 * renders in 83 ms out to a 60,000 ms CI timeout (run 4202).
 *
 * ⚠ WHY A SOURCE BAN AND NOT A RENDER CHECK. `api-og-cards-render-sweep` cannot
 * see this: its stub answers instantly, so a bounded and an unbounded fetch are
 * indistinguishable to it. A test that mocked a HANG would need real timers and
 * a 10 s wall-clock wait per route — which is itself the wall-clock-dependent
 * shape this suite has been burned by twice. The bound is therefore asserted
 * structurally (nothing calls bare `fetch`) plus behaviourally on the helper
 * itself (it attaches a signal, and it yields to one you supply).
 *
 * ⚠ THE EXEMPTIONS ARE THE CURATED LIST, NOT THE BAN. Both already bound
 * themselves, on deliberately different budgets, and both are named here so
 * removing their bound reds this file rather than silently inheriting a pass.
 */

const ROOTS = [path.join(process.cwd(), "app/api/og"), path.join(process.cwd(), "lib/og")]

/**
 * Files allowed to call `fetch` directly, each with the bound it carries
 * instead. Adding a name here without a bound is the failure this is meant to
 * make visible, so each entry also names the mechanism the case below checks.
 */
const SELF_BOUNDED: Record<string, RegExp> = {
  // A card without brand fonts still renders, so this waits less than a data
  // read is worth waiting for. Separate budget on purpose.
  "lib/og/brand-fonts.ts": /AbortSignal\.timeout\(/,
  // Drives its own AbortController rather than a one-shot timeout signal.
  "lib/og/img-data.ts": /new AbortController\(/,
  // The helper itself.
  "lib/og/og-fetch.ts": /AbortSignal\.timeout\(/,
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(p, out)
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && statSync(p).isFile()) out.push(p)
  }
  return out
}

function rel(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/")
}

/**
 * ⚠ The SHARED stripper, never a local copy (`guards-use-the-shared-comment-
 * stripper` is a ratchet). Comments here quote `fetch(` constantly — this file
 * included — so a blind stripper would make the ban fire on its own prose.
 */
function rendered(file: string): string {
  return stripComments(readFileSync(file, "utf8"))
}

/**
 * A call to bare `fetch(`, excluding `ogFetch(`, `.fetch(`, and identifiers that
 * merely END in fetch. The lookbehind is what stops `ogFetch(` matching — the
 * naive `/fetch\(/` flags every call site this guard exists to bless.
 */
const BARE_FETCH = /(?<![\w.])fetch\(/g

describe("OG card reads are bounded", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(r))

  it("inspected a non-empty set of files (the guard cannot pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(40)
  })

  it("nothing under app/api/og or lib/og calls bare fetch", () => {
    const offenders = files
      .map((f) => ({ file: rel(f), calls: (rendered(f).match(BARE_FETCH) ?? []).length }))
      .filter((o) => o.calls > 0 && !(o.file in SELF_BOUNDED))
    expect(
      offenders,
      "An OG card renders while a social crawler holds the connection, and a bare " +
        "fetch() has no timeout — a stalled upstream hangs the render to the platform " +
        "cap and the link previews as a bare URL. Use ogFetch() from lib/og/og-fetch.ts, " +
        "or bound it yourself and add the file to SELF_BOUNDED with the mechanism.",
    ).toEqual([])
  })

  it("every exempted file still carries the bound it is exempted for", () => {
    // Without this the exemption list is a way to REMOVE a bound, not to record
    // a different one — the failure mode that makes an allowlist worse than no
    // allowlist.
    for (const [file, mechanism] of Object.entries(SELF_BOUNDED)) {
      const src = rendered(path.join(process.cwd(), file))
      expect(mechanism.test(src), `${file} is exempted but no longer bounds itself`).toBe(true)
    }
  })

  it("the exemption list names no file that has stopped calling fetch", () => {
    // Keeps it from rotting into a description of the past.
    for (const file of Object.keys(SELF_BOUNDED)) {
      const src = rendered(path.join(process.cwd(), file))
      BARE_FETCH.lastIndex = 0
      expect(BARE_FETCH.test(src), `${file} is exempted but calls no fetch — drop it`).toBe(true)
    }
  })

  it("ogFetch attaches a timeout signal when the caller supplies none", async () => {
    const seen: RequestInit[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response("{}", { status: 200 })
    }) as unknown as typeof globalThis.fetch
    try {
      await ogFetch("https://example.invalid/x", { cache: "no-store" })
    } finally {
      globalThis.fetch = orig
    }
    expect(seen).toHaveLength(1)
    expect(seen[0].signal).toBeInstanceOf(AbortSignal)
    expect(seen[0].cache, "the caller's own init must survive").toBe("no-store")
  })

  it("ogFetch yields to a signal the caller chose", async () => {
    // A helper that OVERRODE a supplied signal would silently break any caller
    // with its own cancellation — a bound is a floor here, not a policy.
    const ac = new AbortController()
    const seen: RequestInit[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (_i: unknown, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response("{}", { status: 200 })
    }) as unknown as typeof globalThis.fetch
    try {
      await ogFetch("https://example.invalid/x", { signal: ac.signal })
    } finally {
      globalThis.fetch = orig
    }
    expect(seen[0].signal).toBe(ac.signal)
  })

  it("the signal ogFetch attaches is a timeout signal for the SHIPPED bound", async () => {
    // Closes the gap the case below cannot: "a signal is attached" is satisfied
    // by any signal, including one that never fires. This asserts the helper
    // asks for a TIMEOUT and asks for the shipped number.
    const spy = vi.spyOn(AbortSignal, "timeout")
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as never
    let args: unknown[][] = []
    try {
      await ogFetch("https://example.invalid/x")
      // ⚠ READ THE CALLS BEFORE RESTORING. `mockRestore()` CLEARS `mock.calls`,
      // so asserting after the `finally` reads an empty array and the case fails
      // on a correct helper — which is exactly how it failed on its first run.
      args = spy.mock.calls.map((c) => [...c])
    } finally {
      globalThis.fetch = orig
      spy.mockRestore()
    }
    expect(args).toEqual([[OG_FETCH_TIMEOUT_MS]])
  })

  it("ogFetch's own bound aborts a hanging read", async () => {
    // End-to-end through the SHIPPED helper, with the clock shortened at the one
    // seam that does not change the code under test: `AbortSignal.timeout` is
    // stubbed to 1 ms, so this exercises ogFetch's real wiring in one tick
    // instead of a 10 s wall-clock wait. (Vitest's fake timers do not control
    // `AbortSignal.timeout` — it runs on a host timer — which is why the seam is
    // the static method and not the clock.)
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(1))
    const orig = globalThis.fetch
    globalThis.fetch = ((_i: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))
      })) as unknown as typeof globalThis.fetch
    try {
      await expect(ogFetch("https://example.invalid/x")).rejects.toThrow(/aborted/)
    } finally {
      globalThis.fetch = orig
      spy.mockRestore()
    }
  })

  it("the shipped bound is a deliberate number, not a default", () => {
    // 10 s is a PRODUCT budget: after that, a degraded card beats no card. The
    // measurement behind it (pack-sniper, n=40, 6 h to 2026-08-30T04:33Z: median
    // ~1.9 s, tail 6.1/6.7/7.8/7.8/10.9 s) says a 5 s bound would abort four of
    // those forty and a 10 s bound aborts one. Pinned so lowering it is a
    // decision someone has to make on purpose.
    expect(OG_FETCH_TIMEOUT_MS).toBe(10_000)
    expect(OG_FETCH_TIMEOUT_MS).toBeGreaterThan(8_000)
  })
})

/**
 * The genuine `AbortSignal.timeout`, captured before any spy replaces it, so the
 * stub above can still build a REAL 1 ms timeout signal rather than recursing
 * into itself.
 */
const real = AbortSignal.timeout.bind(AbortSignal)
