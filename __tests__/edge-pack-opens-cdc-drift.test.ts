import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// The two pack-open ingest edge fns (ingest-allday-pack-opens,
// ingest-topshot-pack-opens-history) carry inline JSON-CDC field/primitive
// unwrap helpers (`field` / `prim` / `isTransient`) that are functional
// duplicates of the ALREADY-TESTED _shared/spork-cursor.ts exports
// (`cdcField` / `cdcPrim` / `isTransient`) — a wrong Optional/typed unwrap
// silently drops ids and starves the backfill. Neither edge fn imports from
// _shared, so this guard pins the inline copies to the tested version: for each,
// the body (with the function's own name canonicalized, so `prim` vs `cdcPrim`
// isn't a false diff) must match _shared byte-for-byte (whitespace/semicolon-
// insensitive). Same import-or-inline mechanism as the other edge-fn guards.

const root = process.cwd()

/** Grab a `function NAME(...) { ... }` body via brace matching (works because
 *  none of these three has an inline-brace return type). */
function extractFn(src: string, name: string): string | null {
  const sig = src.search(new RegExp(`(export\\s+)?function ${name}\\(`))
  if (sig < 0) return null
  const open = src.indexOf("{", sig)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(sig, i + 1)
    }
  }
  return null
}

/** Normalize a fn body for comparison: drop the `export`/`function`/NAME header,
 *  canonicalize the callee names (recursive self-calls) to FN, strip comments,
 *  semicolons and whitespace. */
function canon(body: string, names: string[]): string {
  let s = body
  // strip line comments (the inline copy carries an inline `// ...` note)
  s = s.replace(/\/\/[^\n]*/g, "")
  s = s.replace(/^\s*(export\s+)?function\s+\w+/, "function FN")
  for (const n of names) s = s.replace(new RegExp(`\\b${n}\\b`, "g"), "FN")
  return s.replace(/;/g, "").replace(/\s+/g, " ").trim()
}

const sharedSrc = readFileSync(path.join(root, "supabase/functions/_shared/spork-cursor.ts"), "utf8")

const PAIRS: Array<{ inline: string; shared: string }> = [
  { inline: "field", shared: "cdcField" },
  { inline: "prim", shared: "cdcPrim" },
  { inline: "isTransient", shared: "isTransient" },
]

const EDGE_FNS = ["ingest-allday-pack-opens", "ingest-topshot-pack-opens-history"]

describe("pack-opens edge fns keep their CDC helpers in sync with _shared/spork-cursor", () => {
  for (const fn of EDGE_FNS) {
    const src = readFileSync(path.join(root, `supabase/functions/${fn}/index.ts`), "utf8")
    const importsShared = /from\s+["'][^"']*_shared\/spork-cursor/.test(src)
    for (const { inline, shared } of PAIRS) {
      it(`${fn}: inline ${inline} matches _shared ${shared} (or is imported)`, () => {
        const inlineBody = extractFn(src, inline)
        if (importsShared || inlineBody === null) return // imported, or not defined inline
        const sharedBody = extractFn(sharedSrc, shared)
        expect(sharedBody, `_shared must define ${shared}`).not.toBeNull()
        expect(canon(inlineBody, [inline])).toBe(canon(sharedBody!, [shared]))
      })
    }
  }
})
