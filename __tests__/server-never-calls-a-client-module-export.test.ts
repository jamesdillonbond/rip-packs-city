import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ⛔ A server module (page.tsx, layout.tsx, a route, a lib helper) may RENDER a component
// imported from a "use client" file, but it may not CALL one of that file's exports. In the
// server bundle every export of a client module is a reference stub, so the call throws
// "Attempted to call X() from the server but X is on the client" — at RENDER time only.
//
// 2026-10-26: app/special-serial-owners/page.tsx called boardSeed() from
// SpecialSerialOwnersClient.tsx; every signed-in visit to the board 500ed. tsc, vitest and lint
// were green; only CI's build-render job (minutes, after the push) saw it. This walk sees it in
// milliseconds. Fix shape: move the pure helper to a plain module both files import
// (app/special-serial-owners/board-seed.ts).
//
// Walks EVERY non-client module in app/, lib/ and components/ (a tree walk, not a list).

const ROOT = process.cwd()

function walkDir(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const rel = `${dir}/${name}`
    if (statSync(join(ROOT, rel)).isDirectory()) walkDir(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null
  const base = spec.startsWith("@/") ? spec.slice(2) : join(dirname(from), spec).replace(/\\/g, "/")
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = base + ext
    if (existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile()) return p
  }
  return null
}

const clientCache = new Map<string, boolean>()
function isClient(rel: string): boolean {
  if (!clientCache.has(rel)) {
    clientCache.set(rel, /^\s*["']use client["']/.test(stripComments(readFileSync(join(ROOT, rel), "utf8"))))
  }
  return clientCache.get(rel)!
}

const escape = (s: string) => s.replace(/[$]/g, "\\$")

/** `file calls name from client` for every server module calling a named export of a client module. */
export function serverCallsIntoClient(rel: string, src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
    const target = resolve(rel, m[2])
    if (!target || !isClient(target)) continue
    const rest = src.replace(m[0], "")
    for (const raw of m[1].split(",")) {
      const n = raw.trim()
      if (!n || n.startsWith("type ")) continue
      const local = n.split(/\s+as\s+/).pop()!.trim()
      // A call `name(`, not JSX `<name` and not a member `.name(`.
      if (new RegExp(`(?<![<\\w.])${escape(local)}\\s*\\(`).test(rest)) out.push(`${rel} calls ${local}() from ${target}`)
    }
  }
  return out
}

describe("server modules never CALL an export of a \"use client\" module", () => {
  const files = ["app", "lib", "components"].flatMap((d) => walkDir(d))
  const server = files.filter((f) => !isClient(f))

  it("the walk inspects the server tree (not vacuous)", () => {
    expect(server.length).toBeGreaterThan(500)
    expect(server).toContain("app/special-serial-owners/page.tsx")
  })

  it("no server module calls a client module's export", () => {
    const offenders = server.flatMap((f) => serverCallsIntoClient(f, stripComments(readFileSync(join(ROOT, f), "utf8"))))
    expect(offenders).toEqual([])
  })

  it("the detector catches the 2026-10-26 shape (planted defect)", () => {
    const planted = `import SpecialSerialOwnersClient, { boardSeed } from "./SpecialSerialOwnersClient"
export default async function P(props) { const seed = boardSeed(await props.searchParams); return <SpecialSerialOwnersClient initialPlayer={seed.player} /> }`
    expect(serverCallsIntoClient("app/special-serial-owners/page.tsx", planted)).toEqual([
      "app/special-serial-owners/page.tsx calls boardSeed() from app/special-serial-owners/SpecialSerialOwnersClient.tsx",
    ])
    // Rendering a client component is fine; only a call is a defect.
    const rendered = `import { default as X, Foo } from "./SpecialSerialOwnersClient"
export default function P() { return <Foo a={1} /> }`
    expect(serverCallsIntoClient("app/special-serial-owners/page.tsx", rendered)).toEqual([])
  })
})
