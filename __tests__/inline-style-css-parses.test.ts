import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"

// css-tree ships no type declarations; type the one call this needs.
const csstree = createRequire(import.meta.url)("css-tree") as {
  parse(css: string, opts: { onParseError: (e: { message: string }) => void }): unknown
}

// EVERY INLINE `<style>{`…`}</style>` IN app/ AND components/ PARSES AS CSS.
//
// 2026-10-12. A comment in a copy-pasted reset — "so p-*/m-* classes rendered
// as 0" — contains `*/`, which CLOSES the comment mid-sentence. The rest of the
// prose became CSS, and Chromium's error recovery folded it into the next rule's
// prelude, so `@layer base{*{box-sizing:border-box;margin:0;padding:0;}}` was
// DROPPED on 8 surfaces, including app/(collections)/layout.tsx (verified in
// Chromium: 1 rule parsed with it, 2 without). Invisible on screen only because
// Tailwind preflight carries the same reset.
//
// `no-unlayered-universal-reset` passed throughout: it reads TEXT, saw the
// `@layer`, and cannot know a comment ate its context. The only instrument that
// noticed was a slow test: jsdom re-parsed the broken sheet on every
// getComputedStyle, and component-DashboardClient took 85 s instead of 21 s.
// So this parses the CSS, the way a browser does.

const ROOTS = ["app", "components"]
const STYLE = /<style[^>]*>\{`([\s\S]*?)`\}<\/style>/g

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out)
    } else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** Parse errors for one template body. `${…}` interpolations become a neutral token. */
function cssParseErrors(template: string): string[] {
  const errs: string[] = []
  csstree.parse(template.replace(/\$\{[^}]*\}/g, "0"), {
    onParseError: (e: { message: string }) => errs.push(e.message),
  })
  return errs
}

describe("inline <style> templates parse as CSS", () => {
  const blocks: { file: string; css: string }[] = []
  for (const f of ROOTS.flatMap((r) => walk(r))) {
    for (const m of readFileSync(f, "utf8").matchAll(STYLE)) blocks.push({ file: f, css: m[1] })
  }

  it("walks a real population", () => {
    expect(blocks.length).toBeGreaterThan(20)
    expect(blocks.some((b) => b.file.endsWith("DashboardClient.tsx"))).toBe(true)
  })

  it("no block has a CSS parse error", () => {
    const bad = blocks
      .map((b) => ({ file: b.file, errs: cssParseErrors(b.css) }))
      .filter((b) => b.errs.length > 0)
      .map((b) => `${b.file}: ${b.errs[0]}`)
    expect(bad).toEqual([])
  })

  it("the detector catches the exact 10-12 defect, and passes its fix", () => {
    const shape = (c: string) => `
      /* this reset MUST sit in @layer base, so ${c} classes
         rendered as 0 on every page under it. */
      @layer base{*{box-sizing:border-box;margin:0;padding:0;}}
      .rpc-section { padding:16px 18px; }`
    expect(cssParseErrors(shape("p-*/m-*")).length).toBeGreaterThan(0)
    expect(cssParseErrors(shape("p-* and m-*"))).toEqual([])
  })
})
