import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { COLLECTIONS } from "@/lib/collections"
import { accentFill, labelOn, readableFill, readableOn, contrastRatio } from "@/lib/accent-text"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// White label text on the brand red #E03A2F reads 4.36:1 — under WCAG AA's 4.5
// for normal-size text — and axe flagged it on every primary button, active tab
// and Subscribe CTA (2026-10-24). The decision: keep #E03A2F for accents,
// borders, bars and the wordmark, and paint LABELLED fills with
// --rpc-red-fill (hover --rpc-red-fill-hover). This file pins the property.

const ROOT = join(__dirname, "..")
const CSS = readFileSync(join(ROOT, "app", "rpc-tokens.css"), "utf8")

function token(name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS)
  if (!m) throw new Error(`token ${name} not found as a hex in rpc-tokens.css`)
  return m[1]
}
function resolve(v: string): string {
  const m = /^var\((--[a-z-]+)/.exec(v.trim())
  return m ? token(m[1]) : v
}

describe("--rpc-red-fill tokens", () => {
  it("white reads >= 4.5:1 on the fill and on its hover", () => {
    for (const t of ["--rpc-red-fill", "--rpc-red-fill-hover"]) {
      const r = contrastRatio(token(t), "#FFFFFF")!
      expect(r, `${t} ${token(t)} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it("the brand red itself still does NOT (the premise — if it ever does, this whole layer can go)", () => {
    expect(contrastRatio(token("--rpc-red"), "#FFFFFF")!).toBeLessThan(4.5)
  })
})

describe("accentFill + labelOn — every registry accent", () => {
  it("the label clears AA on the fill it is painted on", () => {
    const accents = [...new Set(COLLECTIONS.map((c) => c.accent).filter(Boolean) as string[])]
    expect(accents.length).toBeGreaterThan(0)
    for (const a of [...accents, "var(--rpc-red)", "#E03A2F"]) {
      const fill = resolve(accentFill(a))
      const label = labelOn(a) === "#fff" ? "#FFFFFF" : labelOn(a)
      const r = contrastRatio(fill, label)!
      expect(r, `${label} on ${fill} (accent ${a}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })
  it("passes non-red accents through unchanged", () => {
    expect(accentFill("#1D428A")).toBe("#1D428A")
    expect(accentFill("var(--rpc-red)")).toBe("var(--rpc-red-fill)")
  })
})

describe("readableFill — a team colour no label can read on", () => {
  it("darkens Rayo Vallecano's red just enough for white", () => {
    expect(Math.max(contrastRatio("#E53027", "#FFFFFF")!, contrastRatio("#E53027", "#0B0B0D")!)).toBeLessThan(4.5)
    const f = readableFill("#E53027")!
    expect(f).not.toBe("#E53027")
    expect(contrastRatio(f, readableOn(f))!).toBeGreaterThanOrEqual(4.5)
  })
  it("leaves a fill that already has a readable label alone", () => {
    for (const c of ["#1D428A", "#C1D32F", "#000000", "#FFFFFF"]) expect(readableFill(c)).toBe(c)
    expect(readableFill("var(--x)")).toBe("var(--x)")
    expect(readableFill(null)).toBeNull()
  })
})

// Tree walk — no source line paints white text on the raw brand red again.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(e)) out.push(p)
  }
  return out
}
const RAW_RED_BG = /background(-color)?\s*:[^;\n]*var\(--rpc-red(-hover)?(\s*,\s*#[0-9a-fA-F]{6})?\)/
const WHITE_TEXT = /color\s*:[^;\n]*?(['"`(: ]|^)?(#fff\b|#ffffff\b|white\b)/i

export function findWhiteOnRawRed(src: string): number[] {
  const lines = stripComments(src).split("\n")
  const hits: number[] = []
  lines.forEach((ln: string, i: number) => {
    if (!RAW_RED_BG.test(ln)) return
    // Same line, or (2026-10-24) the same multi-line style object: a white
    // \`color\` within two lines either side, with no brace between them. The
    // same-line form alone missed two blog CTAs written one property per line.
    if (WHITE_TEXT.test(ln)) return void hits.push(i + 1)
    for (const j of [i - 2, i - 1, i + 1, i + 2]) {
      if (j < 0 || j >= lines.length) continue
      const between = lines.slice(Math.min(i, j) + 1, Math.max(i, j)).join("\n") + (j < i ? lines[j].split(/color\s*:/)[1] ?? "" : lines[j].split(/color\s*:/)[0])
      if (WHITE_TEXT.test(lines[j]) && !/[{}]/.test(between) && !/background/.test(lines[j])) return void hits.push(i + 1)
    }
  })
  return hits
}

describe("tree walk: white label text on the raw brand red", () => {
  it("catches a planted defect", () => {
    expect(findWhiteOnRawRed(`<a style={{ background: "var(--rpc-red)", color: "#fff" }} />`)).toEqual([1])
    expect(findWhiteOnRawRed(`.x:hover{background:var(--rpc-red-hover);color:#fff}`)).toEqual([1])
    expect(findWhiteOnRawRed(`.x{background:var(--rpc-red,#E03A2F);color:#fff}`)).toEqual([1])
    expect(findWhiteOnRawRed(`<a style={{ background: "var(--rpc-red-fill)", color: "#fff" }} />`)).toEqual([])
    // one property per line (the 10-24 blog CTA shape)
    expect(findWhiteOnRawRed(`const CTA = {\n  padding: 8,\n  background: "var(--rpc-red, #E03A2F)",\n  color: "#fff",\n}`)).toEqual([3])
    // a white colour in a DIFFERENT object two lines away is not this object's label
    expect(findWhiteOnRawRed(`const A = { background: "var(--rpc-red)" }\nconst B = { color: "#fff" }`)).toEqual([])
  })
  it("finds none in app/ or components/", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))]
    expect(files.length).toBeGreaterThan(500)
    const bad: string[] = []
    for (const f of files) for (const n of findWhiteOnRawRed(readFileSync(f, "utf8"))) bad.push(`${relative(ROOT, f)}:${n}`)
    expect(bad, "use var(--rpc-red-fill) (hover: var(--rpc-red-fill-hover)) under white label text").toEqual([])
  })
})
