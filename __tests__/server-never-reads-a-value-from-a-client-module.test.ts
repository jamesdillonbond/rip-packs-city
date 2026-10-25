import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// A module without "use client" that imports a NON-COMPONENT value (a string,
// number, object) from a "use client" module does not get the value when it
// renders on the server: it gets a client-reference stub. Found 2026-10-25 in a
// production HTML sweep: SkipToContent.tsx (server, root layout) read
// PAGE_CONTENT_ANCHOR_ATTR from SkipToContentLink.tsx ("use client"), so every
// page shipped a CSS selector made of a stringified `throw Error(...)` function,
// and <PageContentAnchor /> rendered an attribute with that name instead of
// data-rpc-content-anchor. The skip link's 10-24 fix (focus the deepest anchor)
// found no anchor and always fell back. vitest renders both halves in one
// process, so the component test could not see it.
//
// Rule (ban at zero, tree walk): no non-client file under app/, components/ or
// lib/ imports a non-function `export const` from a "use client" file. Shared
// constants go in a plain module (components/skip-to-content-attr.ts).

const ROOTS = ["app", "components", "lib"]
const FUNCTION_INIT = /^(\(|async\b|function\b|memo\(|forwardRef\(|React\.|dynamic\()/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".next") walk(p, out)
    } else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p)
  }
  return out
}

function isClient(src: string): boolean {
  return /^\s*["']use client["']/.test(stripComments(src))
}

/** client file -> its exported non-function consts. */
export function clientValueExports(files: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [f, src] of Object.entries(files)) {
    if (!isClient(src)) continue
    for (const m of stripComments(src).matchAll(/^export const ([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n]{0,40})/gm)) {
      if (FUNCTION_INIT.test(m[2].trim())) continue
      ;(out[f] ??= []).push(m[1])
    }
  }
  return out
}

export function violations(files: Record<string, string>): string[] {
  const client = clientValueExports(files)
  const hits: string[] = []
  for (const [f, src] of Object.entries(files)) {
    if (isClient(src)) continue
    for (const m of stripComments(src).matchAll(/import\s+(?!type\b)([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
      const spec = m[2]
      const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? join(dirname(f), spec) : null
      if (!base) continue
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const target = client[base + ext]
        if (!target) continue
        const named = (m[1].match(/\{([^}]*)\}/)?.[1] ?? "")
          .split(",")
          .map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0])
          .filter(Boolean)
        for (const n of named) if (target.includes(n)) hits.push(`${f} imports ${n} from ${base + ext}`)
      }
    }
  }
  return hits
}

describe("a server module never reads a value exported by a \"use client\" module", () => {
  const files = Object.fromEntries(ROOTS.flatMap((r) => walk(r)).map((f) => [f, readFileSync(f, "utf8")]))

  it("inspects a real population", () => {
    expect(Object.keys(files).length).toBeGreaterThan(1000)
    expect(Object.keys(clientValueExports(files)).length).toBeGreaterThan(5)
  })

  it("catches the 10-25 shape (planted defect)", () => {
    const planted = {
      "components/Link.tsx": `"use client"\nexport const ATTR = "data-x"\nexport default function L() { return null }\n`,
      "components/Server.tsx": `import L, { ATTR } from "@/components/Link"\nexport const CSS = \`[\${ATTR}]{}\`\n`,
      "components/Ok.tsx": `import L from "@/components/Link"\n`,
    }
    expect(violations(planted)).toEqual(["components/Server.tsx imports ATTR from components/Link.tsx"])
  })

  it("no server module in the tree does it", () => {
    expect(violations(files)).toEqual([])
  })
})
