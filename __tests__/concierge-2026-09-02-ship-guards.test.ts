import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// Three properties shipped 2026-09-02 that FAIL SILENTLY when broken. None of
// them produces an error, a wrong type, or a failing existing test — each just
// quietly stops doing its job, which is why they are pinned as source text.
//
// 1. The prompt-cache breakpoint. `buildSystemPromptParts` splits the system
//    prompt into `cacheable` (sent with cache_control) and `dynamic`. Moving
//    ANY per-request value above the split is not a bug the type system or a
//    behavioural test can see: the answer stays correct and the cache simply
//    never hits again, at ~21,119 tokens of prefix per iteration. Measured
//    2026-09-02: a warm request reported cache_read 21,119 / cache_write 0.
//
// 2. The collection-slug derivation. `SupportChatConnected` used to treat
//    segments[0] as a collection unconditionally, so the public mounts sent
//    collectionId "insights" — a slug no collection has — and every tool that
//    defaults to the page's collection resolved a null UUID. Nothing threw.
//
// 3. The FMV distribution's population count. The count and the fetch MUST
//    apply identical predicates; a population figure taken over a different
//    WHERE than the sample is worse than none, because it reads as authority.
// ─────────────────────────────────────────────────────────────────────────────

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8")
}

describe("prompt-cache breakpoint holds only invariant text", () => {
  const ROUTE = src(join("app", "api", "support-chat", "route.ts"))

  it("splits the prompt into cacheable + dynamic and sends both as system blocks", () => {
    expect(ROUTE).toContain("const cacheable = `You are the RPC Concierge")
    expect(ROUTE).toContain("const dynamic = `${collectionBlurb}")
    expect(ROUTE).toContain("return { cacheable, dynamic }")
    expect(ROUTE).toContain("cache_control: { type: \"ephemeral\" }")
    // Both call sites (streaming and non-streaming) must send the blocks, not
    // a plain string — one left behind is a silent half-price regression.
    const blockSends = ROUTE.match(/system: systemBlocks,/g) ?? []
    expect(blockSends.length, "both Anthropic calls must send systemBlocks").toBe(2)
    expect(ROUTE).not.toContain("system: systemPrompt,")
  })

  it("the cacheable literal interpolates nothing that varies per request", () => {
    // Everything between `const cacheable = \`` and the closing backtick that
    // precedes `const dynamic`. Anything of the form ${...} in there is sent
    // above the cache breakpoint on every request.
    const start = ROUTE.indexOf("const cacheable = `")
    const end = ROUTE.indexOf("const dynamic = `")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const cacheable = ROUTE.slice(start, end)
    const interpolations = [...cacheable.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim())
    // publishedLabels is derived from lib/collections.ts and is therefore
    // constant for a given deploy — it is the ONE allowed interpolation. A new
    // name showing up here means someone moved a per-user or per-page value
    // above the breakpoint; move it into `dynamic` instead of widening this.
    expect(
      interpolations.filter((n) => n !== "publishedLabels"),
      "per-request values must live in `dynamic`, BELOW the cache breakpoint — " +
        "anything here is re-sent uncached on every request and every tool-loop iteration",
    ).toEqual([])
  })
})

describe("only a real collection slug is treated as a collection", () => {
  const CONNECTED = src(join("components", "SupportChatConnected.tsx"))

  it("asks lib/collections whether the first path segment is a collection", () => {
    expect(CONNECTED).toContain("getCollection")
    expect(CONNECTED).toContain("isCollectionRoute")
    // The exact shape of the 2026-09-02 regression: segments[0] taken as the
    // collection id with no membership check.
    expect(CONNECTED).not.toMatch(/const collectionId = segments\[0\]/)
  })

  it("labels the public surfaces the chat is now mounted on", () => {
    for (const label of ['"home"', '(insights)']) {
      expect(CONNECTED, `public surface label ${label} missing`).toContain(label)
    }
  })
})

describe("the FMV distribution counts the population it sampled", () => {
  const DIST = src(join("lib", "concierge", "fmv-distribution.ts"))

  it("counts and fetches through ONE filter builder", () => {
    expect(DIST).toContain("applyCatalogFilters")
    expect(DIST).toContain('count: "exact", head: true')
    // Every unified-path predicate must live INSIDE the builder. The builder
    // reassigns `out`; the Pinnacle path below it reassigns `query`, and that
    // is the discriminator — a `query = query.ilike("player_name"` or a second
    // `query = query.ilike("set_name"` in the UNIFIED path is the drift that
    // makes the count describe a different population than the sample.
    // (set_name is legitimately used twice in the file: once in the builder,
    // once in the Pinnacle path, which has its own separate query.)
    for (const pred of ['out.ilike("player_name"', 'out.ilike("set_name"', 'out.eq("collection_id"']) {
      expect(DIST, `${pred} must live inside applyCatalogFilters`).toContain(pred)
    }
    expect(
      DIST.split('query = query.ilike("player_name"').length - 1,
      "the unified path must not re-apply player_name outside the builder",
    ).toBe(0)
    expect(
      DIST.split('query = query.ilike("set_name"').length - 1,
      "only the Pinnacle path may apply set_name directly to `query`",
    ).toBe(1)
  })

  it("orders the capped read so two identical calls agree", () => {
    // Without an ORDER BY, LIMIT returns PHYSICAL order, which shifts as the
    // table is rewritten — the same filter could report different percentiles
    // on consecutive calls and neither would look wrong.
    expect(DIST).toContain('order("external_id"')
  })

  it("tells the caller when the percentiles are a slice", () => {
    expect(DIST).toContain("population_matched")
    expect(DIST).toContain("truncation_note")
    const ROUTE = src(join("app", "api", "support-chat", "route.ts"))
    // The fields are worthless if the formatter drops them before the model
    // ever sees them, and the prompt rule is worthless without the fields.
    expect(ROUTE).toContain("population_matched: result.population_matched")
    expect(ROUTE).toContain("truncated: true, the percentiles are a SLICE")
  })
})
