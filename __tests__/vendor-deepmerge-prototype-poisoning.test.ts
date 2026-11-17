import { describe, it, expect } from "vitest"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"

// GHSA-gcqx-w48m-w2h4 (deepmerge ≥4.2.0, no upstream fix — 4.3.1 is latest): mergeObject()
// copied a TARGET's own `__proto__` key with plain assignment, so a JSON.parse'd target
// re-pointed the RETURNED object's prototype. `vendor/deepmerge` is 4.3.1 + a fix, wired in
// as a root `file:` dependency and `"deepmerge": "$deepmerge"` in package.json `overrides`
// (a NESTED `file:` override resolves relative to the dependent package and writes a lockfile
// `npm ci` rejects — measured 2026-11-16). Planted-defect proof: the "returns an object whose
// prototype is Object.prototype" case FAILS against upstream deepmerge 4.3.1 (`polluted === 1`).
const req = createRequire(import.meta.url)
const root = path.resolve(__dirname, "..")
const VENDORED = path.join(root, "vendor", "deepmerge", "index.js")
type Merge = ((a: unknown, b: unknown, o?: object) => Record<string, unknown>) & {
  all: (xs: unknown[], o?: object) => Record<string, unknown>
}
const deepmerge = req(VENDORED) as Merge

describe("vendored deepmerge — prototype poisoning closed", () => {
  it("a JSON-parsed TARGET carrying __proto__ does not re-point the result's prototype", () => {
    const target = JSON.parse('{"__proto__":{"polluted":1},"a":1}')
    const out = deepmerge(target, { b: 2 })
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
    expect(out).toEqual({ a: 1, b: 2 })
  })

  it("a JSON-parsed SOURCE carrying __proto__ / constructor / prototype is not copied", () => {
    const source = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":{"y":1},"c":3}')
    const out = deepmerge({ a: 1 }, source)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.keys(out).sort()).toEqual(["a", "c"])
  })

  it("poison nested one level down is dropped too", () => {
    const target = JSON.parse('{"n":{"__proto__":{"polluted":1},"k":1}}')
    const out = deepmerge(target, { n: { j: 2 } })
    const n = out.n as Record<string, unknown>
    expect(Object.getPrototypeOf(n)).toBe(Object.prototype)
    expect(n.polluted).toBeUndefined()
    expect(n).toEqual({ k: 1, j: 2 })
  })

  it("never pollutes Object.prototype globally", () => {
    deepmerge.all([JSON.parse('{"__proto__":{"globalPoison":1}}'), JSON.parse('{"__proto__":{"globalPoison":1}}')])
    expect(({} as { globalPoison?: unknown }).globalPoison).toBeUndefined()
  })
})

describe("vendored deepmerge — ordinary merges unchanged from upstream 4.3.1", () => {
  it("deep-merges objects and concatenates arrays", () => {
    expect(deepmerge({ a: { x: 1 }, l: [1] }, { a: { y: 2 }, l: [2] })).toEqual({ a: { x: 1, y: 2 }, l: [1, 2] })
  })
  it("source wins on scalar conflict and does not mutate inputs", () => {
    const t = { a: 1, n: { k: 1 } }
    const out = deepmerge(t, { a: 2, n: { k: 2 } })
    expect(out).toEqual({ a: 2, n: { k: 2 } })
    expect(t).toEqual({ a: 1, n: { k: 1 } })
    expect(out.n).not.toBe(t.n)
  })
  it("honours arrayMerge / customMerge / isMergeableObject options and .all", () => {
    expect(deepmerge({ l: [1] }, { l: [2] }, { arrayMerge: (_t: unknown[], s: unknown[]) => s })).toEqual({ l: [2] })
    const custom = deepmerge({ k: { a: 1 } }, { k: { b: 2 } }, { customMerge: () => () => "custom" })
    expect(custom).toEqual({ k: "custom" })
    const d = new Date(0)
    expect(deepmerge({ d: { x: 1 } }, { d }).d).toBe(d)
    expect(deepmerge.all([{ a: 1 }, { b: 2 }, { c: 3 }])).toEqual({ a: 1, b: 2, c: 3 })
  })
  it("result keys are ordinary enumerable, writable own properties", () => {
    const out = deepmerge({ a: 1 }, { b: 2 })
    const desc = Object.getOwnPropertyDescriptor(out, "b")
    expect(desc).toMatchObject({ value: 2, writable: true, enumerable: true, configurable: true })
  })
})

describe("wiring — @onflow/sdk resolves the vendored copy, not the registry package", () => {
  it("package.json pins the root file: dep and the $deepmerge override", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
    expect(pkg.dependencies.deepmerge).toBe("file:vendor/deepmerge")
    expect(pkg.overrides.deepmerge).toBe("$deepmerge")
  })
  it("the lockfile carries no registry deepmerge anywhere", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"))
    const hits = Object.entries(lock.packages as Record<string, { resolved?: string }>)
      .filter(([k]) => k === "node_modules/deepmerge" || k.endsWith("/node_modules/deepmerge"))
    expect(hits.length).toBeGreaterThan(0)
    for (const [, v] of hits) expect(v.resolved).toBe("vendor/deepmerge")
  })
  it("module resolution from @onflow/sdk lands on vendor/deepmerge", () => {
    const sdk = req.resolve("@onflow/sdk")
    expect(req.resolve("deepmerge", { paths: [sdk] })).toBe(VENDORED)
  })
})
