import { describe, it, expect } from "vitest"
import { parseRichText, safeHref, isExternalHref, type RichToken } from "@/lib/concierge/rich-text"

// The concierge bubble used to render its message as a raw string, so every
// link the bot handed out was inert text. This tokenizer makes them clickable.
//
// The security cases below are not hypothetical hygiene. Concierge output is
// model-generated text that quotes tool results, and tool results carry values
// RPC does not control (collector handles, set names, board rows). The two
// properties that must never regress:
//   1. the output is TOKENS, never markup — asserted structurally here and by
//      a source guard that forbids dangerouslySetInnerHTML in the chat path;
//   2. only http/https/site-relative targets ever become a clickable href.

function texts(tokens: RichToken[]): string {
  return tokens.map((t) => (t.type === "bold" ? t.text : t.text)).join("")
}
function links(tokens: RichToken[]) {
  return tokens.filter((t): t is Extract<RichToken, { type: "link" }> => t.type === "link")
}

describe("safeHref — scheme allow-list", () => {
  it("accepts http, https and site-relative paths", () => {
    expect(safeHref("https://www.rippackscity.com/insights")).toBe("https://www.rippackscity.com/insights")
    expect(safeHref("http://example.com")).toBe("http://example.com")
    expect(safeHref("/insights/deals")).toBe("/insights/deals")
  })

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["  javascript:alert(1)"],
    ["data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["mailto:a@b.c"],
  ])("rejects %s", (raw) => {
    expect(safeHref(raw)).toBeNull()
  })

  it("rejects protocol-relative URLs, which look site-relative but leave the site", () => {
    expect(safeHref("//evil.example.com/steal")).toBeNull()
  })

  it("rejects a URL carrying control characters or a newline", () => {
    expect(safeHref("https://example.com/a\nb")).toBeNull()
    expect(safeHref("https://example.com/a\tb")).toBeNull()
  })

  it("returns null for empty input", () => {
    expect(safeHref("")).toBeNull()
    expect(safeHref("   ")).toBeNull()
  })
})

describe("parseRichText — links", () => {
  it("turns a markdown link into a link token", () => {
    const t = parseRichText("See [the deals board](/insights/deals) for more.")
    expect(links(t)).toEqual([{ type: "link", text: "the deals board", href: "/insights/deals" }])
    expect(texts(t)).toContain("See ")
    expect(texts(t)).toContain(" for more.")
  })

  it("linkifies a bare absolute URL", () => {
    const t = parseRichText("Try https://www.rippackscity.com/insights/top-sales today")
    expect(links(t)[0].href).toBe("https://www.rippackscity.com/insights/top-sales")
  })

  it("linkifies a site-relative path the bot hands out", () => {
    const t = parseRichText("The board lives at /insights/first-mint and updates hourly.")
    expect(links(t)[0]).toMatchObject({ href: "/insights/first-mint" })
  })

  it("keeps sentence punctuation out of the href", () => {
    const t = parseRichText("Check /insights/deals, then /pricing.")
    expect(links(t).map((l) => l.href)).toEqual(["/insights/deals", "/pricing"])
    // The punctuation survives in the prose rather than being eaten.
    expect(texts(t)).toContain(",")
    expect(texts(t).endsWith(".")).toBe(true)
  })

  // The guard that keeps ordinary prose from being mangled into links.
  it.each([
    ["a date like 8/13 is not a path", "8/13"],
    ["and/or is not a path", "and/or"],
    ["a ratio 3/5 is not a path", "3/5"],
  ])("%s", (_label, input) => {
    expect(links(parseRichText(`value ${input} here`))).toHaveLength(0)
  })

  it("renders an unsafe markdown target as plain text instead of a link", () => {
    const t = parseRichText("[click me](javascript:alert(document.cookie))")
    expect(links(t)).toHaveLength(0)
    // Content is preserved — a message never silently loses text.
    expect(texts(t)).toContain("click me")
  })

  it("never emits a link token for a hostile scheme anywhere in the message", () => {
    const t = parseRichText("hi [x](javascript:1) and [y](data:text/html,z) and [ok](/insights)")
    expect(links(t).map((l) => l.href)).toEqual(["/insights"])
  })
})

describe("parseRichText — bold and mixed content", () => {
  it("emits a bold token", () => {
    const t = parseRichText("FMV is **$26** right now")
    expect(t.some((x) => x.type === "bold" && x.text === "$26")).toBe(true)
  })

  it("handles bold and a link in one message, in order", () => {
    const t = parseRichText("**Top sales** are at /insights/top-sales")
    expect(t[0]).toMatchObject({ type: "bold", text: "Top sales" })
    expect(links(t)[0].href).toBe("/insights/top-sales")
  })

  it("prefers the markdown link reading over the bare-path reading", () => {
    const t = parseRichText("[deals](/insights/deals)")
    expect(links(t)).toEqual([{ type: "link", text: "deals", href: "/insights/deals" }])
    expect(t).toHaveLength(1)
  })
})

describe("parseRichText — preserves the message", () => {
  it("returns plain text unchanged when there is nothing to mark up", () => {
    const msg = "Logged that bug — the team will see it in the triage queue. Anything else?"
    expect(parseRichText(msg)).toEqual([{ type: "text", text: msg }])
  })

  it("keeps newlines so pre-wrap still lays the message out", () => {
    const t = parseRichText("line one\n\nline two")
    expect(texts(t)).toBe("line one\n\nline two")
  })

  it("returns nothing for an empty message", () => {
    expect(parseRichText("")).toEqual([])
  })

  // Whatever the input, the visible characters must survive tokenization —
  // a renderer that drops content is worse than one that under-links.
  it.each([
    "plain",
    "**bold** and [a](/b) and https://x.com/y and /insights/deals.",
    "weird ** unclosed and [broken](  ) and //evil.com",
    "<script>alert(1)</script>",
  ])("is content-preserving for %s", (input) => {
    const rebuilt = parseRichText(input)
      .map((t) => (t.type === "link" ? t.text : t.text))
      .join("")
    // Link tokens drop the markdown syntax around them, so compare the visible
    // characters with markdown punctuation removed from the expectation.
    // Only MATCHED pairs are stripped: an unclosed "**" is not bold syntax and
    // the parser is right to leave it as literal text.
    const strippedInput = input
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    expect(rebuilt).toBe(strippedInput)
  })

  it("never returns a token type other than text/bold/link", () => {
    const t = parseRichText("**a** [b](/c) https://d.example /e")
    expect(new Set(t.map((x) => x.type)).size).toBeGreaterThan(0)
    for (const tok of t) expect(["text", "bold", "link"]).toContain(tok.type)
  })
})

describe("isExternalHref", () => {
  it("flags absolute URLs as external and site paths as internal", () => {
    expect(isExternalHref("https://nbatopshot.com/x")).toBe(true)
    expect(isExternalHref("http://x.com")).toBe(true)
    expect(isExternalHref("/insights/deals")).toBe(false)
  })
})

// A source guard, because no type forbids this: `dangerouslySetInnerHTML` in
// the chat render path would turn every value the concierge quotes from a tool
// result — collector handles, set names, board rows, none of which RPC controls
// — into markup. The tokenizer only helps while the renderer refuses to parse
// HTML, so the refusal is pinned here rather than left to review.
// The tokenizer ships to the browser verbatim -- `tsc` cannot transpile a
// regex literal -- so ES2018-only syntax here is a PARSE-time SyntaxError on
// an older engine, which would take out this module and the entire chat
// component with it. Safari only gained lookbehind in 16.4, and this product
// is mobile-heavy, so the pattern is banned rather than trusted.
describe("source guard — no ES2018-only regex syntax", () => {
  it("uses no lookbehind in the tokenizer", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync("lib/concierge/rich-text.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "")
    expect(src).not.toMatch(/\(\?<[=!]/)
  })
})

describe("source guard — the chat path never renders HTML", () => {
  it("has no dangerouslySetInnerHTML in the concierge chat renderer", async () => {
    const { readFileSync } = await import("node:fs")
    // ⚠ Strip comments FIRST. Both files EXPLAIN why they refuse to render
    // HTML, and those explanations name the very API being banned — an
    // unstripped search reads its own rationale as a violation. This repo has
    // now hit that trap three times (pack-dist-contents-not-streamed,
    // collection-analytics-failed-vs-empty-guard, and here).
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    for (const f of ["components/SupportChat.tsx", "lib/concierge/rich-text.ts"]) {
      const src = stripComments(readFileSync(f, "utf8"))
      expect(src, `${f} must not render raw HTML`).not.toContain("dangerouslySetInnerHTML")
    }
  })
})
