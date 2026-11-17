import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-07: a wallet / username input must switch off mobile Safari's
// auto-capitalise and autocorrect — a base58 Candy address is CASE-SENSITIVE
// and a Panini username is mixed-case, so "0X…" or a corrected word reads as
// "this wallet holds nothing". The dashboard's input had it (10-18); the public
// binder's and the home hero's did not. Walk: an <input> whose aria-label
// names a wallet or username carries autoCapitalize="none".

const ROOT = join(__dirname, "..")
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx$/.test(e)) out.push(p)
  }
  return out
}
export function capitalizingWalletInputs(src: string): number[] {
  const s = stripComments(src)
  const hits: number[] = []
  const re = /<input\b[^>]*?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const tag = m[0]
    const label = /aria-label\s*=\s*(?:"([^"]*)"|\{[^}]*\})/.exec(tag)?.[1] ?? ""
    const named = /wallet|username/i.test(label) || /aria-label=\{ariaLabel\}/.test(tag)
    if (!named) continue
    if (!/autoCapitalize\s*=\s*["']none["']/.test(tag)) hits.push(s.slice(0, m.index).split("\n").length)
  }
  return hits
}
describe("wallet / username inputs switch off mobile auto-capitalise", () => {
  it("catches a planted defect", () => {
    expect(capitalizingWalletInputs(`<input aria-label="Wallet address or username" value={v} />`)).toEqual([1])
    expect(capitalizingWalletInputs(`<input\n  aria-label="Wallet address"\n  autoCapitalize="none"\n  autoCorrect="off"\n/>`)).toEqual([])
    expect(capitalizingWalletInputs(`<input aria-label="Search the catalog" />`)).toEqual([])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(400)
    const bad: string[] = []
    for (const f of files) for (const n of capitalizingWalletInputs(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, 'add spellCheck={false} autoCapitalize="none" autoCorrect="off" to the wallet input').toEqual([])
  })
})
