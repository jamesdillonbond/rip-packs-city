// scripts/lib/eszip-source.mjs
//
// Read MODULE SOURCE back out of a Supabase edge-function eszip bundle, and
// canonicalise repo source through the SAME machinery, so the two sides of the
// drift census are compared in the same dialect.
//
// ── WHY PARSING, NOT CONTAINMENT ────────────────────────────────────────────
// The Management API has served /functions/{slug}/body as an eszip bundle since
// ~2026-08-09. The first repair attempt (2026-08-30) checked whether the repo
// source was byte-CONTAINED in the bundle; its own positive control found it
// matched 0 of 38 live bundles. Measured locally the same day with
// @deno/eszip's build(): the bundler TRANSPILES every module before storing it
// — types stripped, formatting reprinted by swc, non-null `!` erased — so repo
// TS can never be byte-contained in a production bundle. (The MCP server's
// get_edge_function shows VERBATIM repo bytes, but that endpoint reads the
// stored upload, not the bundle; the bundle is what /body serves.)
//
// So the sound comparison is: PARSE the bundle (Parser.parseBytes → load →
// getModuleSource), and push the repo source through the same build →
// parse roundtrip (`canonicaliseSource`) so both sides are swc-printed. Two
// identical sources then produce identical (or near-identical — the hosted
// bundler's swc may differ by a version) canonical text, and the census's
// calibration rule in runContentCensus decides whether near-identical is
// close enough to promote mismatches to findings.
//
// ⚠ Parser.parse() (the stream variant) crashes in Node ("read is not a
// function", measured 2026-08-30) — parseBytes is the one that works. A fresh
// Parser per bundle: a wasm panic can leave an instance unusable.
//
// ── CANONICALISATION MECHANICS ──────────────────────────────────────────────
// build() walks the import graph, so a repo entrypoint's imports must resolve:
//   * bare specifiers ("@supabase/supabase-js") are rejected by deno_graph
//     BEFORE the loader is consulted ("not a dependency") unless an import map
//     maps them — so a synthetic map is generated pointing each bare specifier
//     at a stub URL, and the loader answers that stub (and every other
//     non-entrypoint specifier) with kind "external", which records the edge
//     without fetching anything.
//   * The import-map URL itself is fetched THROUGH the loader (build's third
//     argument is just a specifier), so the loader serves its JSON too.
// Specifier TEXT in the printed module source is untouched by the map (proven
// by roundtrip: `from "@supabase/supabase-js"` stays literal), so mapping to
// stubs cannot leak into the comparison.

import { stripComments } from "./strip-comments.mjs"

// Lazy so that unit tests of the pure census logic never load wasm, and so a
// missing devDependency fails with a message naming the fix.
let eszipMod = null
async function eszip() {
  if (!eszipMod) {
    try {
      eszipMod = await import("@deno/eszip")
    } catch (e) {
      throw new Error(
        `@deno/eszip is not installed (npm i -D @deno/eszip) — eszip parse mode needs it: ${e.message}`
      )
    }
  }
  return eszipMod
}

/** True when the wasm-backed parser can be loaded in this runtime. */
export async function eszipAvailable() {
  try { await eszip(); return true } catch { return false }
}

export function bareSpecifiers(src) {
  const out = new Set()
  // `from "x"` covers import-from and export-from; the second pattern catches
  // side-effect imports (`import "x"`), which have no `from`.
  for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g]) {
    for (const m of src.matchAll(re)) {
      const s = m[1]
      if (!s.startsWith(".") && !s.startsWith("/") && !/^(https?:|jsr:|npm:|node:|data:)/.test(s)) out.add(s)
    }
  }
  return [...out]
}

/**
 * Pick the entrypoint specifier out of a parsed bundle's specifier list.
 * Production entrypoints look like
 *   file:///tmp/user_fn_<project>_<fnid>_<n>/source/index.ts
 * `entrypointPath` (from function metadata, when the API provides it) wins;
 * otherwise prefer the `/source/index.ts` shape, then any non-_shared
 * index.ts, then a lone module. Null when genuinely ambiguous — the caller
 * treats that as a failed read, never as "clean".
 *
 * @param {string[]} specifiers
 * @param {string | null} [entrypointPath]
 * @returns {string | null}
 */
export function pickEntrypoint(specifiers, entrypointPath = null) {
  // A production bundle references the function's OWN modules by RELATIVE
  // specifier ("source/index.ts", "source/_shared/util.ts") and every vendored
  // dependency by absolute URL — measured 2026-08-30 on all 38 live bundles
  // (0 file:// among 545+ specifiers each; the first picker looked only for
  // file:// and identified nothing). So "local" means NOT a remote scheme,
  // with file:// normalised away for bundles (and fixtures) that use it.
  const remote = /^(https?:|jsr:|npm:|node:|data:)/
  const norm = (s) => s.replace(/^file:\/\//, "")
  const locals = specifiers.filter((s) => !remote.test(s) && !/\.jsonc?$/.test(s) && !s.endsWith(".d.ts"))
  if (entrypointPath) {
    // The metadata path ("/tmp/user_fn_<ref>_<id>_<n>/source/index.ts") and the
    // bundle's own specifier ("source/index.ts") share only a tail — compare in
    // both directions.
    const hit = locals.find((s) => {
      const p = norm(s)
      return p === entrypointPath || entrypointPath.endsWith(`/${p}`) || p.endsWith(entrypointPath)
    })
    if (hit) return hit
  }
  const exact = locals.filter((s) => {
    const p = norm(s)
    return p === "source/index.ts" || p.endsWith("/source/index.ts")
  })
  if (exact.length === 1) return exact[0]
  const idx = locals.filter((s) => {
    const p = norm(s)
    return p.endsWith("index.ts") && !p.includes("_shared")
  })
  if (idx.length === 1) return idx[0]
  // Several candidates under user_fn_ roots: the entrypoint sits at the top of
  // the function directory, vendored modules nest deeper — take the shortest.
  const userFnIdx = idx.filter((s) => s.includes("user_fn_"))
  if (userFnIdx.length > 1) return userFnIdx.sort((a, b) => a.length - b.length)[0]
  if (locals.length === 1) return locals[0]
  return null
}

/** Log-safe sample of a bundle's module paths for a failed-pick diagnostic. */
function specifierSample(specifiers, max = 6) {
  const files = specifiers.filter((s) => s.startsWith("file://"))
  const sample = (files.length ? files : specifiers).slice(0, max)
  return `${files.length} file:// of ${specifiers.length} total; e.g. ${sample.join(" , ")}`
}

/**
 * Parse a production bundle and return its entrypoint's stored module source.
 * Throws on wasm/parse failure or an unidentifiable entrypoint; the census
 * counts a throw as a failed body read.
 *
 * @param {Uint8Array} bytes
 * @param {{ entrypointPath?: string | null }} [opts]
 * @returns {Promise<{ source: string, specifier: string, specifiers: string[] }>}
 */
export async function extractEntrypointSource(bytes, { entrypointPath = null } = {}) {
  const { Parser } = await eszip()
  const parser = Parser.createInstance ? await Parser.createInstance() : new Parser()
  const specifiers = await parser.parseBytes(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  await parser.load()
  const entry = pickEntrypoint(specifiers, entrypointPath)
  // The diagnostic names module PATHS only (never content) — safe for a CI log,
  // and the only way to learn a bundle shape the picker has not met.
  if (!entry) throw new Error(`cannot identify entrypoint (${specifierSample(specifiers)})`)
  const source = await parser.getModuleSource(entry)
  if (typeof source !== "string" || source.length === 0) {
    throw new Error(`entrypoint ${entry} has empty module source`)
  }
  return { source, specifier: entry, specifiers }
}

/**
 * Push repo source through the same build → parse roundtrip the deployed
 * bundle went through, yielding swc-printed text comparable with
 * extractEntrypointSource's output.
 *
 * @param {string} src
 * @returns {Promise<string>}
 */
export async function canonicaliseSource(src) {
  const { build, Parser } = await eszip()
  const spec = "file:///canon/fn/index.ts"
  const mapUrl = "file:///canon/import_map.json"
  const imports = {}
  for (const b of bareSpecifiers(src)) {
    imports[b] = "https://stub.invalid/" + encodeURIComponent(b) + ".ts"
  }
  const bytes = await build(
    [spec],
    async (s) => {
      if (s === spec) return { kind: "module", specifier: s, content: src }
      if (s === mapUrl) return { kind: "module", specifier: s, content: JSON.stringify({ imports }) }
      return { kind: "external", specifier: s }
    },
    mapUrl
  )
  const parser = Parser.createInstance ? await Parser.createInstance() : new Parser()
  await parser.parseBytes(bytes)
  await parser.load()
  return await parser.getModuleSource(spec)
}

/**
 * Formatting-insensitive normalisation for comparing two swc dialects: strip
 * comments, collapse whitespace, drop spaces beside punctuation, drop
 * semicolons. Aggressive by design — BOTH sides get the identical transform,
 * and the census only consults this after plainer comparisons miss, so the
 * false-equal direction requires two sources that differ ONLY in constructs
 * this erases, which is not a drift worth waking anyone for.
 */
export function tightNormalise(src) {
  return stripComments(src)
    .replace(/;/g, " ") // to SPACE, and before tightening — deleting outright would glue `1;console` into `1console` while `1 console` stays split
    .replace(/\s+/g, " ")
    .replace(/ ?([^A-Za-z0-9_$ ]) ?/g, "$1")
    .trim()
}
